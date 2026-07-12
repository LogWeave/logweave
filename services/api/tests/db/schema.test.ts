import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import pino from 'pino'
import { initSchema } from '../../src/db/schema.js'
import { closeTestClient, getTestClient, jsonRows } from './helpers.js'

const logger = pino({ level: 'silent' })

describe('initSchema', () => {
  const client = getTestClient()

  after(async () => {
    await closeTestClient()
  })

  it('creates all tables and views (idempotent — runs twice without error)', async () => {
    // First run
    await initSchema(client, logger)
    // Second run — should not throw
    await initSchema(client, logger)

    const result = await client.query({ query: 'SHOW TABLES FROM logweave' })
    const rows = await jsonRows<{ name: string }>(result)
    const tableNames = rows.map((r) => r.name).sort()

    assert.ok(tableNames.includes('log_metadata'), 'log_metadata table should exist')
    assert.ok(tableNames.includes('template_stats'), 'template_stats table should exist')
    assert.ok(tableNames.includes('template_stats_mv'), 'template_stats_mv view should exist')
    assert.ok(tableNames.includes('service_stats'), 'service_stats table should exist')
    assert.ok(tableNames.includes('service_stats_mv'), 'service_stats_mv view should exist')
    assert.ok(tableNames.includes('service_stats_5m'), 'service_stats_5m table should exist')
    assert.ok(tableNames.includes('service_stats_5m_mv'), 'service_stats_5m_mv view should exist')
    assert.ok(tableNames.includes('alert_rules'), 'alert_rules table should exist')
    assert.ok(tableNames.includes('alert_history'), 'alert_history table should exist')
  })

  it('records migrations in the ledger and does not replay them on a second init', async () => {
    await initSchema(client, logger)
    const count = async (): Promise<number> => {
      const r = await client.query({
        query: 'SELECT count() AS n FROM logweave.schema_migrations FINAL',
      })
      const rows = await jsonRows<{ n: string | number }>(r)
      return Number(rows[0]?.n ?? 0)
    }
    const first = await count()
    assert.ok(first > 0, 'ledger should record applied migrations')
    // A second init must skip every already-applied migration — the ledger count
    // stays flat, proving the DROP VIEW + recreate steps no longer replay.
    await initSchema(client, logger)
    assert.equal(await count(), first, 'second init must not re-apply migrations')
  })

  it('resource guardrails are attempted without crashing (best-effort)', async () => {
    // ALTER USER may fail on Docker ClickHouse where the default user is
    // XML-defined (readonly storage). initSchema should log a warning and
    // continue — it must not throw.
    await initSchema(client, logger)
    // If we get here without throwing, the best-effort path works
  })
})
