/**
 * Archive compaction sweep integration test (epic #265, #284).
 *
 * Proves the destructive merge end to end against real Floci + ClickHouse: a
 * closed partition with several small objects (one event duplicated across two)
 * is ingested, then compacted — the originals are merged + de-duped into one
 * object, the source_refs are repointed in log_metadata, and the originals are
 * deleted from S3. Asserts no data loss and a correct repoint.
 *
 * Requires ClickHouse + Floci up. Auto-skips if Floci is unreachable.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import pino from 'pino'
import { ArchiveCompactionSweep } from '../../src/archive/compaction-sweep.js'
import { ArchiveNotifyConsumer } from '../../src/archive/notify-consumer.js'
import { ArchiveNotifyQueue } from '../../src/archive/notify-queue.js'
import { buildArchiveConfig } from '../../src/connectors/archive-config.js'
import { S3Adapter } from '../../src/connectors/s3-adapter.js'
import { initSchema } from '../../src/db/schema.js'
import { AnomalyScorer } from '../../src/pipeline/anomaly-scorer.js'
import type { ClusterClient, ClusterResult } from '../../src/pipeline/cluster-client.js'
import { closeTestClient, getTestClient, getTestDb, jsonRows, testTenantId } from '../db/helpers.js'

const FLOCI_ENDPOINT = process.env.FLOCI_ENDPOINT ?? 'http://localhost:4566'
const REGION = 'us-east-1'
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' }
const BUCKET = 'logweave-logs'
const logger = pino({ level: 'silent' })

function mockClusterClient(templateId: string): ClusterClient {
  return {
    consecutiveFailures: 0,
    isCircuitOpen: false,
    async cluster(_t: string, messages: string[]): Promise<ClusterResult[]> {
      return messages.map(() => ({ templateId, templateText: 'x <*>', isNewTemplate: false }))
    },
  } as unknown as ClusterClient
}

async function flociUp(): Promise<boolean> {
  try {
    const res = await fetch(FLOCI_ENDPOINT, { signal: AbortSignal.timeout(2000) })
    return res.status > 0
  } catch {
    return false
  }
}

/** A partition prefix whose hour ended well over the safety lag ago. */
function closedPartition(tenantId: string, service: string): string {
  const w = new Date(Date.now() - 25 * 3_600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `tenant=${tenantId}/service=${service}/date=${w.getUTCFullYear()}-${p(
    w.getUTCMonth() + 1,
  )}-${p(w.getUTCDate())}/hour=${p(w.getUTCHours())}/`
}

describe('ArchiveCompactionSweep integration (Floci + ClickHouse)', () => {
  let up = false
  let s3: S3Client | undefined

  before(async () => {
    up = await flociUp()
    if (!up) return
    s3 = new S3Client({
      endpoint: FLOCI_ENDPOINT,
      region: REGION,
      credentials: CREDS,
      forcePathStyle: true,
    })
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => {})
    await initSchema(getTestClient(), logger)
  })

  after(async () => {
    s3?.destroy()
    await closeTestClient()
  })

  it('merges a closed partition, repoints source_refs, and deletes originals — no loss', async (t) => {
    if (!up || !s3) return t.skip('Floci not reachable')

    const tenantId = testTenantId('compact')
    const service = 'billing'
    const templateId = `tpl-compact-${Date.now()}`
    const run = Date.now()
    const part = closedPartition(tenantId, service)
    const db = getTestDb()
    const archiveConfig = buildArchiveConfig({
      bucket: BUCKET,
      region: REGION,
      endpoint: FLOCI_ENDPOINT,
      accessKeyId: CREDS.accessKeyId,
      secretAccessKey: CREDS.secretAccessKey,
    })
    assert.ok(archiveConfig)

    // event_id must be a real UUID, else ingest replaces it with a fresh UUIDv7
    // per row and the dup would never collapse in ClickHouse.
    const uid = (n: string) => `0190b3a0-0000-7000-8000-0000000${n}`
    const ev = (id: string, msg: string) => ({
      event_id: id,
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      service,
      level: 'info',
      message: msg,
    })
    // Shared dup must be byte-identical in both objects (same event_id AND
    // timestamp) so ReplacingMergeTree collapses its two metadata rows.
    const dup = ev(uid('00d02'), 'shared')
    const objects: Record<string, ReturnType<typeof ev>[]> = {
      [`${part}o1-${run}.log.gz`]: [ev(uid('00a01'), 'invoice a'), dup],
      [`${part}o2-${run}.log.gz`]: [dup, ev(uid('00b03'), 'invoice b')],
    }
    for (const [key, events] of Object.entries(objects)) {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: gzipSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`)),
          ContentType: 'application/x-ndjson',
        }),
      )
    }
    const originalKeys = Object.keys(objects)

    // Ingest both objects so log_metadata rows carry source_ref = each original.
    const queue = new ArchiveNotifyQueue()
    const consumer = new ArchiveNotifyConsumer({
      queue,
      archiveConfig,
      adapter: new S3Adapter(),
      logger,
      ingest: {
        clusterClient: mockClusterClient(templateId),
        db,
        logger,
        anomalyScorer: new AnomalyScorer({ db, logger }),
      },
    })
    for (const key of originalKeys) queue.enqueue({ tenantId, sourceRef: key })
    assert.equal(await consumer.drainOnce(), 2)

    // Compact.
    const sweep = new ArchiveCompactionSweep(
      {
        db,
        adapter: new S3Adapter(),
        archiveConfig,
        settingsStore: { getAllTenantIds: () => [tenantId] },
        logger,
      },
      { minObjectsToCompact: 2, safetyLagHours: 2 },
    )
    const res = await sweep.compactOnce()
    assert.equal(res.partitionsCompacted, 1)
    assert.equal(res.objectsRemoved, 2)

    // S3: originals gone, exactly one _compacted- object under the partition.
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: part }))
    const keysNow = (listed.Contents ?? []).map((o) => o.Key ?? '')
    assert.equal(
      keysNow.some((k) => originalKeys.includes(k)),
      false,
      'originals must be deleted',
    )
    const compacted = keysNow.filter((k) => k.includes('_compacted-'))
    assert.equal(compacted.length, 1, 'exactly one compacted object')

    // Compacted object holds the de-duped union (3 events, not 4).
    const events = await new S3Adapter().fetchObjectEvents(archiveConfig, compacted[0])
    assert.equal(events.length, 3, 'dup event collapsed')

    // ClickHouse: all rows for this tenant now point at the compacted key, none
    // at the originals (the mutation was synchronous).
    // FINAL collapses the duplicated event_id's two rows; without it the
    // pre-merge count would be 4.
    const countAt = async (ref: string): Promise<number> => {
      const r = await getTestClient().query({
        query: `SELECT count() AS n FROM logweave.log_metadata FINAL
                WHERE tenant_id = {t:String} AND source_ref = {ref:String}`,
        query_params: { t: tenantId, ref },
        format: 'JSONEachRow',
      })
      return Number((await jsonRows<{ n: string }>(r))[0]?.n ?? 0)
    }
    assert.equal(await countAt(compacted[0]), 3, 'all rows repointed to compacted key')
    assert.equal(await countAt(originalKeys[0]), 0, 'no rows left on an original key')
  })
})
