import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import { initSchema } from '../../src/db/schema.js'
import { uuidv7 } from '../../src/uuid.js'
import { closeTestClient, getTestClient, jsonRows, testTenantId } from './helpers.js'

const logger = pino({ level: 'silent' })

/** ClickHouse DateTime64 literal ('YYYY-MM-DD HH:MM:SS.mmm') for `offsetMs` from now. */
function chTime(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').replace('Z', '')
}

/**
 * A raw log_metadata row. Timestamps must be RECENT — the table's 30-day TTL
 * DELETEs stale rows on merge, which would non-deterministically empty the test.
 */
function row(tenantId: string, eventId: string, ingestTime: string, anomalyScore: number) {
  return {
    id: uuidv7(),
    event_id: eventId,
    tenant_id: tenantId,
    timestamp: chTime(),
    ingest_time: ingestTime,
    service: 'dedup-svc',
    level: 'INFO',
    environment: 'test',
    template_id: 'tpl-1',
    template_text: 'hello <*>',
    is_new_template: 0,
    anomaly_score: anomalyScore,
    status_code: 200,
    duration_ms: 1,
    trace_id: '',
    route: '/x',
    source_type: 'transport',
    source_ref: '',
    preprocessing_version: 1,
  }
}

/** Count matching rows, polling briefly to absorb read-after-write delay. */
async function countWhere(
  client: ReturnType<typeof getTestClient>,
  where: string,
  params: Record<string, unknown>,
): Promise<number> {
  let n = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200))
    const res = await client.query({
      query: `SELECT count() AS n, max(anomaly_score) AS score
              FROM logweave.log_metadata FINAL WHERE ${where}`,
      query_params: params,
      format: 'JSONEachRow',
    })
    const rows = await jsonRows<{ n: string; score: number }>(res)
    n = Number(rows[0]?.n ?? 0)
    if (n > 0) return n
  }
  return n
}

describe('log_metadata ReplacingMergeTree(event_id) dedup', () => {
  const client = getTestClient()

  before(async () => {
    await initSchema(client, logger)
  })

  after(async () => {
    await closeTestClient()
  })

  it('uses the ReplacingMergeTree engine', async () => {
    const res = await client.query({
      query: `SELECT engine FROM system.tables WHERE database = 'logweave' AND name = 'log_metadata'`,
      format: 'JSONEachRow',
    })
    const rows = await jsonRows<{ engine: string }>(res)
    assert.equal(rows[0]?.engine, 'ReplacingMergeTree')
  })

  it('collapses a replayed event_id to one row under FINAL, keeping the latest ingest_time', async () => {
    const tenantId = testTenantId('dedup-replay')
    const eventId = uuidv7()
    // Same event replayed: identical ORDER BY key, later ingest_time wins.
    await client.insert({
      table: 'logweave.log_metadata',
      values: [row(tenantId, eventId, chTime(0), 0.1), row(tenantId, eventId, chTime(5000), 0.9)],
      format: 'JSONEachRow',
    })

    const res = await client.query({
      query: `SELECT count() AS n, max(anomaly_score) AS score
              FROM logweave.log_metadata FINAL
              WHERE tenant_id = {tenant:String} AND event_id = {event:String}`,
      query_params: { tenant: tenantId, event: eventId },
      format: 'JSONEachRow',
    })
    const rows = await jsonRows<{ n: string; score: number }>(res)
    assert.equal(Number(rows[0]?.n), 1, 'duplicate event_id should collapse to one row')
    assert.equal(Number(rows[0]?.score), 0.9, 'latest ingest_time should win')
  })

  it('keeps distinct event_ids as separate rows', async () => {
    const tenantId = testTenantId('dedup-distinct')
    const a = uuidv7()
    const b = uuidv7()
    await client.insert({
      table: 'logweave.log_metadata',
      values: [row(tenantId, a, chTime(0), 0.2), row(tenantId, b, chTime(0), 0.3)],
      format: 'JSONEachRow',
    })

    const n = await countWhere(
      client,
      'tenant_id = {tenant:String} AND event_id IN ({a:String}, {b:String})',
      { tenant: tenantId, a, b },
    )
    assert.equal(n, 2, 'distinct event_ids must not collapse')
  })

  // NOTE: in-place migration of a legacy MergeTree log_metadata was removed in
  // #294 Phase 1 — initSchema now refuses to start on an engine mismatch rather
  // than dropping the table. That guard (assertLogMetadataEngine) is covered in
  // schema-migrations.test.ts.
})
