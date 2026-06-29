/**
 * Archive notify consumer integration test (epic #265, #277).
 *
 * Proves the seam-C consumer end to end: an object in the archive bucket +
 * a notify item → the consumer GETs it, clusters it (mock clusterer), and
 * writes log_metadata rows carrying the correct source_ref + template_id, in
 * real ClickHouse. This is the "notify → consumer → metadata written" DoD.
 *
 * Requires ClickHouse (LOGWEAVE_CLICKHOUSE_URL or localhost:8123) and Floci
 * (FLOCI_ENDPOINT or localhost:4566) up. Auto-skips if Floci is unreachable.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pino from 'pino'
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

/** Mock clusterer: every message clusters to a single deterministic template. */
function mockClusterClient(templateId: string): ClusterClient {
  return {
    consecutiveFailures: 0,
    isCircuitOpen: false,
    async cluster(_t: string, messages: string[]): Promise<ClusterResult[]> {
      return messages.map(() => ({
        templateId,
        templateText: 'connection <*> timed out',
        isNewTemplate: false,
      }))
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

describe('ArchiveNotifyConsumer integration (Floci + ClickHouse)', () => {
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
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => {}) // already exists is fine
    await initSchema(getTestClient(), logger)
  })

  after(async () => {
    s3?.destroy()
    await closeTestClient()
  })

  it('drains a notify item → GETs the object → writes log_metadata with source_ref + template_id', async (t) => {
    if (!up || !s3) return t.skip('Floci not reachable')

    const tenantId = testTenantId('consumer')
    const service = 'payments'
    const templateId = `tpl-consumer-${Date.now()}`
    const key = `tenant=${tenantId}/service=${service}/date=2026-06-29/hour=00/obj-${Date.now()}.log.gz`

    // Write a gzip NDJSON object exactly as Vector would.
    const events = Array.from({ length: 4 }, (_, i) => ({
      event_id: `${tenantId}-evt-${i}`,
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      service,
      level: 'error',
      message: `connection ${i} timed out after 30000ms`,
    }))
    const body = gzipSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`))
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/x-ndjson',
      }),
    )

    // Build the consumer with real db + S3Adapter and a mock clusterer.
    const db = getTestDb()
    const queue = new ArchiveNotifyQueue()
    const archiveConfig = buildArchiveConfig({
      bucket: BUCKET,
      region: REGION,
      endpoint: FLOCI_ENDPOINT,
      accessKeyId: CREDS.accessKeyId,
      secretAccessKey: CREDS.secretAccessKey,
    })
    assert.ok(archiveConfig)

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

    queue.enqueue({ tenantId, sourceRef: key, service })
    const processed = await consumer.drainOnce()
    assert.equal(processed, 1, 'one item processed')

    // The rows are in ClickHouse with the right source_ref + template_id.
    // Alias the aggregates away from column names (ClickHouse resolves a bare
    // `source_ref` in WHERE to the aggregate alias otherwise).
    let rows: { n: string; tid: string; stype: string; sref: string }[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200))
      const res = await getTestClient().query({
        query: `SELECT count() AS n, any(template_id) AS tid,
                       any(source_type) AS stype, any(source_ref) AS sref
                FROM logweave.log_metadata
                WHERE tenant_id = {t:String} AND source_ref = {ref:String}`,
        query_params: { t: tenantId, ref: key },
        format: 'JSONEachRow',
      })
      rows = await jsonRows(res)
      if (Number(rows[0]?.n ?? 0) >= events.length) break
    }

    assert.equal(Number(rows[0]?.n), events.length, `expected ${events.length} rows for the object`)
    assert.equal(rows[0]?.stype, 's3')
    assert.equal(rows[0]?.sref, key)
    assert.equal(rows[0]?.tid, templateId)
  })
})
