/**
 * Producer-side cutover integration test (epic #265, LW-278).
 *
 * Proves the keystone the epic was missing: production traffic flowing THROUGH
 * the archive. The new `forwardToVector` producer (the ingest routes' durable
 * path) POSTs a batch to the real Vector archive engine; Vector gzips it into
 * S3 (gated 200); the async consumer (#277) then GETs the landed object,
 * clusters it, and writes log_metadata with the real template_id — no
 * synchronous clusterer on the hot path, no template_id='0' window.
 *
 * Also asserts the tenant-isolation property: the authenticated tenant_id is
 * stamped server-side and OVERRIDES any client-supplied tenant_id, so a forged
 * tenant_id cannot land an object under another tenant's prefix (#275 note).
 *
 * Requires the dev stack up (Floci + Vector + ClickHouse):
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d floci floci-init vector clickhouse
 * Auto-skips if Floci or Vector is unreachable — same convention as the other
 * archive integration tests.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import pino from 'pino'
import { ArchiveNotifyConsumer } from '../../src/archive/notify-consumer.js'
import { ArchiveNotifyQueue } from '../../src/archive/notify-queue.js'
import { forwardToVector } from '../../src/archive/vector-forwarder.js'
import { buildArchiveConfig } from '../../src/connectors/archive-config.js'
import { S3Adapter } from '../../src/connectors/s3-adapter.js'
import { initSchema } from '../../src/db/schema.js'
import { AnomalyScorer } from '../../src/pipeline/anomaly-scorer.js'
import type { ClusterClient, ClusterResult } from '../../src/pipeline/cluster-client.js'
import { closeTestClient, getTestClient, getTestDb, jsonRows, testTenantId } from '../db/helpers.js'

const FLOCI_ENDPOINT = process.env.FLOCI_ENDPOINT ?? 'http://localhost:4566'
const VECTOR_ENDPOINT = process.env.VECTOR_ENDPOINT ?? 'http://localhost:8686'
const ARCHIVE_URL = `${VECTOR_ENDPOINT}/v1/archive`
const REGION = 'us-east-1'
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' }
const BUCKET = process.env.LOGWEAVE_ARCHIVE_BUCKET ?? 'logweave-logs'
const logger = pino({ level: 'silent' })

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

async function reachable(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    return res.status > 0
  } catch {
    return false
  }
}

describe('Archive cutover integration: forwardToVector → S3 → consumer', () => {
  let up = false
  let s3: S3Client | undefined

  before(async () => {
    up = (await reachable(FLOCI_ENDPOINT)) && (await reachable(ARCHIVE_URL))
    if (!up) return
    s3 = new S3Client({
      endpoint: FLOCI_ENDPOINT,
      region: REGION,
      credentials: CREDS,
      forcePathStyle: true,
    })
    await initSchema(getTestClient(), logger)
  })

  after(async () => {
    s3?.destroy()
    await closeTestClient()
  })

  it('forwards a batch to Vector, lands it under the AUTHENTICATED tenant, and the consumer enriches it', async (t) => {
    if (!up || !s3) return t.skip('Floci/Vector not reachable')

    const tenantId = testTenantId('cutover')
    const service = `svc-${Date.now()}`
    const templateId = `tpl-cutover-${Date.now()}`

    // Client supplies a FORGED tenant_id — the forwarder must override it with
    // the authenticated tenantId, so the object lands under tenantId, not this.
    const events = Array.from({ length: 4 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      tenant_id: 'attacker-tenant',
      level: 'error',
      message: `connection ${i} timed out after 30000ms`,
    }))

    // Producer side: POST to the REAL Vector. Resolves only on the S3-gated 200,
    // so the object is in S3 the moment this returns.
    await forwardToVector({ url: ARCHIVE_URL }, events, { tenantId, service })

    // The forged tenant prefix must be empty; the authenticated one holds the object.
    const forged = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'tenant=attacker-tenant/' }),
    )
    assert.equal(
      forged.Contents?.some((o) => o.Key?.includes(`service=${service}/`)) ?? false,
      false,
      'a forged client tenant_id must not place an object under another tenant prefix',
    )

    const prefix = `tenant=${tenantId}/service=${service}/`
    let key: string | undefined
    for (let attempt = 0; attempt < 5 && !key; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200))
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))
      key = listed.Contents?.[0]?.Key
    }
    assert.ok(key, `expected a landed object under ${prefix}`)

    // Consumer side: drive the landed object through the existing async path.
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
    assert.equal(processed, 1, 'one object processed')

    // Rows are in ClickHouse: real template_id (not '0'), source_type=s3, and
    // the authenticated tenant_id — clustering happened off the hot path.
    let rows: { n: string; tid: string; stype: string; sref: string; tenant: string }[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200))
      const res = await getTestClient().query({
        query: `SELECT count() AS n, any(template_id) AS tid, any(source_type) AS stype,
                       any(source_ref) AS sref, any(tenant_id) AS tenant
                FROM logweave.log_metadata
                WHERE tenant_id = {t:String} AND source_ref = {ref:String}`,
        query_params: { t: tenantId, ref: key },
        format: 'JSONEachRow',
      })
      rows = await jsonRows(res)
      if (Number(rows[0]?.n ?? 0) >= events.length) break
    }

    assert.equal(Number(rows[0]?.n), events.length, `expected ${events.length} enriched rows`)
    assert.equal(rows[0]?.tid, templateId)
    assert.notEqual(rows[0]?.tid, '0', 'rows must be clustered, never left pending')
    assert.equal(rows[0]?.stype, 's3')
    assert.equal(rows[0]?.sref, key)
    assert.equal(rows[0]?.tenant, tenantId)
  })
})
