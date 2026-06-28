/**
 * Vector archive-engine integration test (epic #265, issue #273).
 *
 * Proves seam B end to end against real Vector + the Floci S3 emulator:
 *   - gzip NDJSON objects land at the deterministic key_prefix
 *     `tenant=.../service=.../date=%F/hour=%H/`;
 *   - the 200 is GATED on S3 delivery (#274): the archive sink uses a memory
 *     buffer + acknowledgements + when_full="block", so the instant the awaited
 *     POST resolves the object(s) are already in S3 — asserted synchronously,
 *     no polling. A disk buffer would ack before S3 and fail these assertions;
 *   - objects are SIZE-BOUNDED with no loss: one POST over `batch.max_bytes`
 *     lands as MULTIPLE objects whose union is every event — the cost guarantee
 *     depends on not emitting one tiny object per event;
 *   - a TINY batch only flushes on `batch.timeout_secs`, so the gated POST
 *     blocks ~timeout before the 200.
 *
 * Requires the dev stack up (Floci + Vector on the dev config, whose
 * batch.max_bytes=64KiB / timeout=5s make both paths assertable in seconds):
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d floci floci-init vector
 *
 * Auto-skips if either Floci (FLOCI_ENDPOINT) or Vector (VECTOR_ENDPOINT) is
 * unreachable — same convention as s3-adapter.integration.test.ts.
 */

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { buildArchiveConfig } from '../../src/connectors/archive-config.js'
import { S3Adapter } from '../../src/connectors/s3-adapter.js'

const FLOCI_ENDPOINT = process.env.FLOCI_ENDPOINT ?? 'http://localhost:4566'
const VECTOR_ENDPOINT = process.env.VECTOR_ENDPOINT ?? 'http://localhost:8686'
const ARCHIVE_PATH = '/v1/archive'
const BUCKET = process.env.LOGWEAVE_ARCHIVE_BUCKET ?? 'logweave-logs'
const REGION = 'us-east-1'
const STATIC_CREDS = { accessKeyId: 'test', secretAccessKey: 'test' }

// Mirror the dev vector.dev.toml thresholds so the assertions stay meaningful
// if those are ever tuned.
const BATCH_MAX_BYTES = 65536
const BATCH_TIMEOUT_SECS = 5

const s3 = new S3Client({
  endpoint: FLOCI_ENDPOINT,
  region: REGION,
  credentials: STATIC_CREDS,
  forcePathStyle: true,
})

async function reachable(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timeout)
    // Any HTTP answer (even 4xx for a GET on a POST-only path) means it's up.
    return res.status > 0
  } catch {
    return false
  }
}

/** POST newline-delimited JSON to Vector. */
async function postBatch(events: object[]): Promise<number> {
  const body = events.map((e) => JSON.stringify(e)).join('\n')
  const res = await fetch(`${VECTOR_ENDPOINT}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body,
  })
  return res.status
}

async function listUnderPrefix(prefix: string): Promise<string[]> {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))
  return (out.Contents ?? []).map((o) => o.Key ?? '').filter(Boolean)
}

async function readGzipNdjson(key: string): Promise<Record<string, unknown>[]> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  assert.ok(obj.Body, `object ${key} has a body`)
  const raw = Buffer.from(await obj.Body.transformToByteArray())
  assert.deepEqual([...raw.subarray(0, 2)], [0x1f, 0x8b], `object ${key} must be gzip`)
  return gunzipSync(raw)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
}

/** List under a prefix and read all event_ids across the objects (one pass). */
async function collectEventIds(prefix: string): Promise<{ ids: Set<string>; keys: string[] }> {
  const keys = await listUnderPrefix(prefix)
  const ids = new Set<string>()
  for (const key of keys) {
    for (const ev of await readGzipNdjson(key)) ids.add(String(ev.event_id))
  }
  return { ids, keys }
}

describe('Vector archive integration (Floci + Vector)', async () => {
  let up = false

  before(async () => {
    up = (await reachable(FLOCI_ENDPOINT)) && (await reachable(VECTOR_ENDPOINT))
  })

  it('size-splits a large batch into multiple gzip objects, all durable when the 200 returns', async (t) => {
    if (!up) return t.skip('Floci/Vector not reachable')

    // Unique partition per run so concurrent/repeat runs never collide.
    const tenant = `t-${Date.now()}`
    const service = `svc-${Date.now()}`
    // ~1000 events * ~195 B ≈ 195 KB, comfortably over the 64 KiB cap, so
    // Vector flushes several size-bounded objects from this one POST.
    const events = Array.from({ length: 1000 }, (_, i) => ({
      event_id: `evt-${i}`,
      tenant_id: tenant,
      service,
      message: `connection ${i} timed out after 30000ms to upstream 10.0.0.${i % 256}`,
      level: 'error',
    }))
    const totalBytes = events.map((e) => JSON.stringify(e)).join('\n').length
    assert.ok(totalBytes > BATCH_MAX_BYTES, `fixture must exceed the cap (${totalBytes}B)`)

    assert.equal(await postBatch(events), 200)

    // The 200 is gated on S3 delivery of EVERY event (the source ack is
    // all-or-nothing for the request), so a single synchronous pass — NO
    // polling — must already see all objects. This is the multi-object form of
    // the delivery gate: a partial ack (some objects in S3, the 200 returned
    // anyway) would drop event_ids here and fail the count.
    const prefix = `tenant=${tenant}/service=${service}/`
    const { ids, keys } = await collectEventIds(prefix)

    // Multiple objects from one POST = size triggered the flush (a single
    // timer flush of the whole batch would be one object).
    assert.ok(keys.length >= 2, `expected size-split into >=2 objects, got ${keys.length}`)
    for (const key of keys) {
      assert.match(key, /^tenant=[^/]+\/service=[^/]+\/date=\d{4}-\d{2}-\d{2}\/hour=\d{2}\//)
    }
    // Every event is durable across the objects — no loss, no dupes, no partial ack.
    assert.equal(ids.size, events.length, `expected all ${events.length} events, got ${ids.size}`)
  })

  it('blocks a tiny batch until the timeout flush, then 200s with it durable', async (t) => {
    if (!up) return t.skip('Floci/Vector not reachable')

    const tenant = `t-tiny-${Date.now()}`
    const prefix = `tenant=${tenant}/`
    const start = Date.now()
    assert.equal(
      await postBatch([{ event_id: 'one', tenant_id: tenant, service: 'svc', message: 'hi' }]),
      200,
    )
    const blockedMs = Date.now() - start

    // Below batch.max_bytes → only the timer flushes it, and the 200 is gated on
    // that flush, so the POST itself blocks ~timeout and the object is durable
    // by the time it returns (asserted synchronously, no polling).
    const { keys } = await collectEventIds(prefix)
    assert.equal(keys.length, 1, `expected one object, got ${keys.length}`)
    assert.match(keys[0], /date=\d{4}-\d{2}-\d{2}\/hour=\d{2}\//)
    // It did NOT flush immediately — the gated POST waited ~timeout. Lower bound
    // is generous to absorb jitter.
    assert.ok(
      blockedMs > (BATCH_TIMEOUT_SECS - 2) * 1000,
      `expected the gated POST to block ~${BATCH_TIMEOUT_SECS}s, returned in ${blockedMs}ms`,
    )
  })

  // The no-loss gate (#274): a 200 must NOT be returned before the bytes are in
  // S3. This holds only because the archive sink uses a MEMORY buffer with
  // acknowledgements + when_full="block"; a disk buffer would ack on local disk
  // (before S3) and this test would fail — which is exactly the regression we
  // want the build to catch. Note: NO polling — we list S3 the instant the POST
  // resolves, so a passing assertion proves the 200 was withheld until delivery.
  it('does not return 200 before the object is durable in S3 (delivery gate)', async (t) => {
    if (!up) return t.skip('Floci/Vector not reachable')

    const tenant = `t-gate-${Date.now()}`
    const prefix = `tenant=${tenant}/`
    assert.equal(
      await postBatch([{ event_id: 'g1', tenant_id: tenant, service: 'svc', message: 'gate' }]),
      200,
    )

    // Synchronously after the awaited 200 — no sleep, no retry. If the 200 were
    // returned before S3 delivery (e.g. a disk buffer), this list is empty.
    const keys = await listUnderPrefix(prefix)
    assert.equal(keys.length, 1, `200 returned but object not yet in S3 (found ${keys.length})`)
    const events = await readGzipNdjson(keys[0])
    assert.equal(events.length, 1)
    assert.equal(events[0].event_id, 'g1')
  })

  // #275: drill-down reads the archived object by source_ref and narrows to the
  // lines matching the template — the exact path raw-logs.ts uses for archived
  // logs. Exercises the real S3Adapter against a real Vector-written gz NDJSON
  // object (DoD: set source_ref → drill-down finds it; template regex matches).
  it('drills down into an archived object by source_ref and matches the template', async (t) => {
    if (!up) return t.skip('Floci/Vector not reachable')

    const tenant = `t-drill-${Date.now()}`
    const service = `svc-${Date.now()}`
    // Two distinct templates so we can prove the regex NARROWS, not just reads.
    const matching = Array.from({ length: 5 }, (_, i) => ({
      event_id: `m${i}`,
      tenant_id: tenant,
      service,
      message: `connection ${i} timed out after 30000ms to upstream 10.0.0.${i}`,
    }))
    const noise = [
      { event_id: 'n1', tenant_id: tenant, service, message: 'user alice logged in' },
      { event_id: 'n2', tenant_id: tenant, service, message: 'cache warmed in 12ms' },
    ]
    assert.equal(await postBatch([...matching, ...noise]), 200)

    const prefix = `tenant=${tenant}/service=${service}/`
    const sourceRefs = await listUnderPrefix(prefix)
    assert.ok(sourceRefs.length >= 1, 'archived object should exist after the gated 200')

    const config = buildArchiveConfig({
      bucket: BUCKET,
      region: REGION,
      endpoint: FLOCI_ENDPOINT,
      accessKeyId: STATIC_CREDS.accessKeyId,
      secretAccessKey: STATIC_CREDS.secretAccessKey,
    })
    assert.ok(config, 'archive config should be built')

    const result = await new S3Adapter().fetchRawLogs({
      config,
      templateText: 'connection <*> timed out after <*>ms to upstream <*>',
      service,
      timeRange: { start: new Date(Date.now() - 3_600_000), end: new Date() },
      limit: 50,
      sourceRefs,
    })

    // Found exactly the 5 matching lines, none of the noise.
    assert.equal(
      result.lines.length,
      matching.length,
      `expected 5 matches, got ${result.lines.length}`,
    )
    for (const line of result.lines) {
      assert.match(
        line.message,
        /^connection \d+ timed out after 30000ms to upstream 10\.0\.0\.\d+$/,
      )
      assert.equal(line.source, sourceRefs[0])
    }
  })
})
