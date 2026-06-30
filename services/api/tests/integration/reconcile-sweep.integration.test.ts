/**
 * Archive reconciliation sweep integration test (epic #265, #279).
 *
 * Proves the "no missed object" backfill end to end against real Floci +
 * ClickHouse: several gzip NDJSON objects land in the archive bucket; some are
 * ingested (as if the notify hop delivered them), others are NOT (as if notify
 * dropped them). The reconciliation sweep lists the bucket, finds the gaps,
 * enqueues them, and the existing consumer fills them in — and the durable
 * watermark advances only past confirmed objects.
 *
 * Requires ClickHouse + Floci up. Auto-skips if Floci is unreachable.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pino from 'pino'
import { ArchiveNotifyConsumer } from '../../src/archive/notify-consumer.js'
import { ArchiveNotifyQueue } from '../../src/archive/notify-queue.js'
import { ArchiveReconcileSweep } from '../../src/archive/reconcile-sweep.js'
import { buildArchiveConfig } from '../../src/connectors/archive-config.js'
import { S3Adapter } from '../../src/connectors/s3-adapter.js'
import { getReconcileCursor } from '../../src/db/archive-reconcile-queries.js'
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
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(FLOCI_ENDPOINT, { signal: ctrl.signal })
    clearTimeout(t)
    return res.status > 0
  } catch {
    return false
  }
}

describe('ArchiveReconcileSweep integration (Floci + ClickHouse)', () => {
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

  it('backfills only the missed objects and advances the watermark past confirmed ones', async (t) => {
    if (!up || !s3) return t.skip('Floci not reachable')

    const tenantId = testTenantId('reconcile')
    const service = 'orders'
    const templateId = `tpl-reconcile-${Date.now()}`
    const run = Date.now()
    const db = getTestDb()
    const archiveConfig = buildArchiveConfig({
      bucket: BUCKET,
      region: REGION,
      endpoint: FLOCI_ENDPOINT,
      accessKeyId: CREDS.accessKeyId,
      secretAccessKey: CREDS.secretAccessKey,
    })
    assert.ok(archiveConfig)

    // Land 5 objects with lexically-ordered keys under the tenant prefix.
    const keys: string[] = []
    for (let i = 0; i < 5; i++) {
      const key = `tenant=${tenantId}/service=${service}/date=2026-06-30/hour=00/obj-${run}-${i}.log.gz`
      const event = {
        event_id: `${tenantId}-r${run}-${i}`,
        timestamp: new Date().toISOString(),
        tenant_id: tenantId,
        service,
        level: 'info',
        message: `order ${i} processed`,
      }
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: gzipSync(Buffer.from(`${JSON.stringify(event)}\n`)),
          ContentType: 'application/x-ndjson',
        }),
      )
      keys.push(key)
    }

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

    // Simulate the notify hop delivering only the first 3 objects.
    for (const key of keys.slice(0, 3)) queue.enqueue({ tenantId, sourceRef: key })
    assert.equal(await consumer.drainOnce(), 3)

    const countRows = async (): Promise<number> => {
      const res = await getTestClient().query({
        query: `SELECT count() AS n FROM logweave.log_metadata
                WHERE tenant_id = {t:String} AND source_ref LIKE {p:String}`,
        query_params: { t: tenantId, p: `%obj-${run}-%` },
        format: 'JSONEachRow',
      })
      return Number((await jsonRows<{ n: string }>(res))[0]?.n ?? 0)
    }
    assert.equal(await countRows(), 3, 'only the delivered 3 are present before reconcile')

    // Reconcile: lists all 5, enqueues the 2 gaps; watermark stops before obj-3.
    const sweep = new ArchiveReconcileSweep(
      {
        db,
        adapter: new S3Adapter(),
        archiveConfig,
        queue,
        settingsStore: { getAllTenantIds: () => [tenantId] },
        logger,
        emitter: { emit: () => {} },
      },
      { behindThreshold: 1000 },
    )
    const res1 = await sweep.reconcileOnce()
    assert.equal(res1.missingEnqueued, 2, 'two missed objects enqueued')
    assert.equal(
      await getReconcileCursor(db, tenantId),
      keys[2],
      'watermark stops at last confirmed',
    )

    // Consumer fills the gaps → all 5 now ingested.
    assert.equal(await consumer.drainOnce(), 2)
    for (let attempt = 0; attempt < 5 && (await countRows()) < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(await countRows(), 5, 'all objects backfilled')

    // Second sweep: starts after the watermark, sees obj-3/obj-4 now present,
    // enqueues nothing, and advances the watermark to the last key.
    const res2 = await sweep.reconcileOnce()
    assert.equal(res2.missingEnqueued, 0, 'nothing left to backfill')
    assert.equal(await getReconcileCursor(db, tenantId), keys[4], 'watermark fully advanced')
  })
})
