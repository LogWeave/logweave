import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import pino from 'pino'
import { initSchema } from '../../src/db/schema.js'
import { closeTestClient, getTestClient } from './helpers.js'

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
    const rows = await result.json<{ name: string }>()
    const tableNames = rows.map((r) => r.name).sort()

    assert.ok(tableNames.includes('log_metadata'), 'log_metadata table should exist')
    assert.ok(tableNames.includes('template_stats'), 'template_stats table should exist')
    assert.ok(tableNames.includes('template_stats_mv'), 'template_stats_mv view should exist')
    assert.ok(tableNames.includes('service_stats'), 'service_stats table should exist')
    assert.ok(tableNames.includes('service_stats_mv'), 'service_stats_mv view should exist')
  })

  it('applies resource guardrails to default user', async () => {
    const result = await client.query({
      query: `SELECT name, value FROM system.settings
              WHERE name IN ('max_execution_time', 'max_memory_usage', 'max_rows_to_read')
              ORDER BY name`,
    })
    const rows = await result.json<{ name: string; value: string }>()

    const settings = Object.fromEntries(rows.map((r) => [r.name, r.value]))
    assert.equal(settings.max_execution_time, '30')
    assert.equal(settings.max_memory_usage, '1073741824')
    assert.equal(settings.max_rows_to_read, '10000000')
  })
})
