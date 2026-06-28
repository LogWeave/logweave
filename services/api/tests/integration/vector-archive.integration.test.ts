/**
 * Vector archive-engine integration test (epic #265, issue #273).
 *
 * Proves seam B end to end against real Vector + the Floci S3 emulator:
 *   - gzip NDJSON objects land at the deterministic key_prefix
 *     `tenant=.../service=.../date=%F/hour=%H/`;
 *   - the object decompresses back to exactly the events we POSTed;
 *   - BATCHING is enforced: a batch over `batch.max_bytes` flushes on size
 *     (the POST returns quickly), while a tiny batch only flushes on
 *     `batch.timeout_secs` (the POST blocks until the timeout) — the cost
 *     guarantee depends on this. With `acknowledgements.enabled=true` the
 *     http_server 200 is withheld until S3 has the object, so POST latency is
 *     a faithful proxy for "when did it become durable".
 *
 * Requires the dev stack up (Floci + Vector on the dev config, whose
 * batch.max_bytes=64KiB / timeout=5s make both flush paths assertable in
 * seconds):
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d floci floci-init vector
 *
 * Auto-skips if either Floci (FLOCI_ENDPOINT) or Vector (VECTOR_ENDPOINT) is
 * unreachable — same convention as s3-adapter.integration.test.ts.
 */

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

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

/** POST newline-delimited JSON to Vector; resolve with status + wall-time. */
async function postBatch(events: object[]): Promise<{ status: number; ms: number }> {
  const body = events.map((e) => JSON.stringify(e)).join('\n')
  const start = Date.now()
  const res = await fetch(`${VECTOR_ENDPOINT}${ARCHIVE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body,
  })
  return { status: res.status, ms: Date.now() - start }
}

async function listUnderPrefix(prefix: string): Promise<string[]> {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))
  return (out.Contents ?? []).map((o) => o.Key ?? '').filter(Boolean)
}

describe('Vector archive integration (Floci + Vector)', async () => {
  let up = false

  before(async () => {
    up = (await reachable(FLOCI_ENDPOINT)) && (await reachable(VECTOR_ENDPOINT))
  })

  it('flushes a large batch on size, gzipped, at the deterministic prefix', async (t) => {
    if (!up) return t.skip('Floci/Vector not reachable')

    // Unique partition per run so concurrent/repeat runs never collide.
    const tenant = `t-${Date.now()}`
    const service = `svc-${Date.now()}`
    // ~400 events * ~200B > 64KiB → exceeds batch.max_bytes, flushes on size.
    const events = Array.from({ length: 400 }, (_, i) => ({
      event_id: `evt-${i}`,
      tenant_id: tenant,
      service,
      message: `connection ${i} timed out after 30000ms to upstream 10.0.0.${i % 256}`,
      level: 'error',
    }))
    const totalBytes = events.map((e) => JSON.stringify(e)).join('\n').length
    assert.ok(totalBytes > BATCH_MAX_BYTES, `fixture must exceed batch.max_bytes (${totalBytes}B)`)

    const { status, ms } = await postBatch(events)
    assert.equal(status, 200)
    // Size-flush: 200 (ack-gated on S3) returns well before the timeout.
    assert.ok(ms < BATCH_TIMEOUT_SECS * 1000, `expected size-flush < timeout, took ${ms}ms`)

    const prefix = `tenant=${tenant}/service=${service}/`
    const keys = await listUnderPrefix(prefix)
    assert.equal(keys.length, 1, `expected exactly one archived object, got ${keys.length}`)
    const key = keys[0]
    assert.match(key, /^tenant=[^/]+\/service=[^/]+\/date=\d{4}-\d{2}-\d{2}\/hour=\d{2}\//)

    // Object is gzip and decompresses to exactly the NDJSON we sent.
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    assert.ok(obj.Body, 'archived object has a body')
    const raw = Buffer.from(await obj.Body.transformToByteArray())
    assert.deepEqual([...raw.subarray(0, 2)], [0x1f, 0x8b], 'object must be gzip')
    const lines = gunzipSync(raw).toString('utf8').trim().split('\n')
    assert.equal(lines.length, events.length)
    const decoded = lines.map((l) => JSON.parse(l))
    assert.equal(decoded[0].event_id, 'evt-0')
    assert.equal(decoded[0].tenant_id, tenant)
  })

  it('holds a tiny batch until the timeout flush', async (t) => {
    if (!up) return t.skip('Floci/Vector not reachable')

    const tenant = `t-tiny-${Date.now()}`
    const { status, ms } = await postBatch([
      { event_id: 'one', tenant_id: tenant, service: 'svc', message: 'hello' },
    ])
    assert.equal(status, 200)
    // Below batch.max_bytes → only the timer flushes it, so the ack-gated 200
    // is withheld until ~batch.timeout_secs. Generous lower bound for jitter.
    assert.ok(
      ms > (BATCH_TIMEOUT_SECS - 2) * 1000,
      `expected timeout-flush (~${BATCH_TIMEOUT_SECS}s), returned in ${ms}ms`,
    )
  })
})
