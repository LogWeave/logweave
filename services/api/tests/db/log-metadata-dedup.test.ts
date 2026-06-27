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

  // Covers the dropLegacyLogMetadata path — the actual migration. A fresh boot
  // creates ReplacingMergeTree directly and never exercises this; only an
  // upgrade over a pre-#267 MergeTree table does.
  it('migrates a legacy MergeTree log_metadata to ReplacingMergeTree, preserving MV wiring', async () => {
    // Re-create the legacy (pre-#267) table: plain MergeTree, no event_id.
    await client.command({ query: 'DROP TABLE IF EXISTS logweave.log_metadata' })
    await client.command({
      query: `CREATE TABLE logweave.log_metadata (
        id UUID DEFAULT generateUUIDv7(),
        tenant_id LowCardinality(String),
        timestamp DateTime64(3),
        ingest_time DateTime64(3) DEFAULT now64(3),
        service LowCardinality(String),
        level LowCardinality(String),
        environment LowCardinality(String),
        template_id String DEFAULT '0',
        template_text String DEFAULT '',
        is_new_template UInt8 DEFAULT 0,
        anomaly_score Float32 DEFAULT 0,
        status_code UInt16 DEFAULT 0,
        duration_ms Float64 DEFAULT 0,
        trace_id String DEFAULT '',
        route LowCardinality(String) DEFAULT '',
        source_type LowCardinality(String),
        source_ref String,
        pre_processed_message Nullable(String),
        preprocessing_version UInt8 DEFAULT 1
      ) ENGINE = MergeTree()
      PARTITION BY toYYYYMMDD(timestamp)
      ORDER BY (tenant_id, service, timestamp, level)
      TTL toDateTime(timestamp) + toIntervalDay(30) DELETE
      SETTINGS ttl_only_drop_parts = 1`,
    })

    const engineBefore = await tableEngine(client)
    assert.equal(engineBefore, 'MergeTree', 'precondition: table is legacy MergeTree')

    // The migration: detects the legacy engine, drops + recreates as RMT.
    await initSchema(client, logger)

    assert.equal(await tableEngine(client), 'ReplacingMergeTree', 'engine should be migrated')

    const cols = await client.query({
      query: `SELECT name FROM system.columns WHERE database = 'logweave' AND table = 'log_metadata' AND name = 'event_id'`,
      format: 'JSONEachRow',
    })
    assert.equal((await jsonRows<{ name: string }>(cols)).length, 1, 'event_id column should exist')

    // Dependent MVs reconnect to the recreated table by name.
    const deps = await client.query({
      query: `SELECT dependencies_table FROM system.tables WHERE database = 'logweave' AND name = 'log_metadata'`,
      format: 'JSONEachRow',
    })
    const depRows = await jsonRows<{ dependencies_table: string[] }>(deps)
    assert.ok(
      depRows[0]?.dependencies_table.includes('template_stats_mv'),
      'template_stats_mv should remain wired to the recreated table',
    )
  })
})

async function tableEngine(client: ReturnType<typeof getTestClient>): Promise<string | undefined> {
  const res = await client.query({
    query: `SELECT engine FROM system.tables WHERE database = 'logweave' AND name = 'log_metadata'`,
    format: 'JSONEachRow',
  })
  return (await jsonRows<{ engine: string }>(res))[0]?.engine
}
