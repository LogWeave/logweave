import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import { batchInsert } from '../../src/db/insert.js'
import { initSchema } from '../../src/db/schema.js'
import type { LogMetadataRow } from '../../src/types.js'
import { closeTestClient, getTestClient, testTenantId } from './helpers.js'

const logger = pino({ level: 'silent' })

function makeRow(tenantId: string, overrides?: Partial<LogMetadataRow>): LogMetadataRow {
  return {
    tenant_id: tenantId,
    timestamp: '2026-03-14 12:00:00.000',
    service: 'test-svc',
    level: 'INFO',
    environment: 'test',
    template_id: 'tmpl-mv-1',
    template_text: 'Connection from <*>',
    is_new_template: 0,
    anomaly_score: 0.5,
    duration_ms: 100,
    source_type: 'winston',
    source_ref: 's3://bucket/key',
    ...overrides,
  }
}

describe('materialized views', () => {
  const client = getTestClient()

  before(async () => {
    await initSchema(client, logger)
  })

  after(async () => {
    await closeTestClient()
  })

  it('template_stats MV excludes unclustered rows (template_id=0)', async () => {
    const tenant = testTenantId('mv-exclude')

    await batchInsert(client, [
      // Clustered row — should appear in template_stats
      makeRow(tenant, { template_id: 'tmpl-real', template_text: 'Real template' }),
      // Unclustered row — should NOT appear in template_stats
      makeRow(tenant, { template_id: '0', template_text: '' }),
    ])

    // Force merge for deterministic results
    await client.command({ query: 'OPTIMIZE TABLE logweave.template_stats FINAL' })

    const result = await client.query({
      query: `SELECT template_id,
                     countMerge(occurrence_count) AS cnt
              FROM logweave.template_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY template_id`,
      query_params: { tenant_id: tenant },
    })
    const rows = await result.json<{ template_id: string; cnt: string }>()

    assert.equal(rows.length, 1, 'Only clustered rows should appear')
    assert.equal(rows[0].template_id, 'tmpl-real')
    assert.equal(rows[0].cnt, '1')
  })

  it('avgMerge produces correct results after OPTIMIZE', async () => {
    const tenant = testTenantId('mv-avg')

    // Insert rows with known duration_ms values: 100, 200, 300
    // Expected avg = 200
    await batchInsert(client, [
      makeRow(tenant, { duration_ms: 100 }),
      makeRow(tenant, { duration_ms: 200 }),
      makeRow(tenant, { duration_ms: 300 }),
    ])

    await client.command({ query: 'OPTIMIZE TABLE logweave.template_stats FINAL' })

    const result = await client.query({
      query: `SELECT avgMerge(avg_duration_ms) AS avg_dur
              FROM logweave.template_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY tenant_id`,
      query_params: { tenant_id: tenant },
    })
    const [{ avg_dur }] = await result.json<{ avg_dur: number }>()

    assert.ok(Math.abs(avg_dur - 200) < 0.01, `Expected avg_duration_ms ≈ 200, got ${avg_dur}`)
  })

  it('avgMerge produces correct results WITHOUT OPTIMIZE (production read path)', async () => {
    const tenant = testTenantId('mv-no-optimize')

    await batchInsert(client, [
      makeRow(tenant, { duration_ms: 50 }),
      makeRow(tenant, { duration_ms: 150 }),
    ])

    // No OPTIMIZE — this simulates the production read path
    const result = await client.query({
      query: `SELECT avgMerge(avg_duration_ms) AS avg_dur
              FROM logweave.template_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY tenant_id`,
      query_params: { tenant_id: tenant },
    })
    const [{ avg_dur }] = await result.json<{ avg_dur: number }>()

    assert.ok(
      Math.abs(avg_dur - 100) < 0.01,
      `Expected avg_duration_ms ≈ 100 without OPTIMIZE, got ${avg_dur}`,
    )
  })

  it('countIfMerge correctly counts ERROR rows in template_stats', async () => {
    const tenant = testTenantId('mv-errors')

    await batchInsert(client, [
      makeRow(tenant, { level: 'ERROR' }),
      makeRow(tenant, { level: 'ERROR' }),
      makeRow(tenant, { level: 'INFO' }),
    ])

    await client.command({ query: 'OPTIMIZE TABLE logweave.template_stats FINAL' })

    const result = await client.query({
      query: `SELECT countIfMerge(error_count) AS errs
              FROM logweave.template_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY tenant_id`,
      query_params: { tenant_id: tenant },
    })
    const [{ errs }] = await result.json<{ errs: string }>()
    assert.equal(errs, '2')
  })

  it('service_stats MV counts all rows including unclustered', async () => {
    const tenant = testTenantId('mv-service')

    await batchInsert(client, [
      makeRow(tenant, { template_id: 'real-1', level: 'ERROR' }),
      makeRow(tenant, { template_id: '0', level: 'WARN' }),
      makeRow(tenant, { template_id: 'real-2', level: 'INFO', is_new_template: 1 }),
    ])

    await client.command({ query: 'OPTIMIZE TABLE logweave.service_stats FINAL' })

    const result = await client.query({
      query: `SELECT
                countMerge(log_count)            AS total,
                countIfMerge(error_count)         AS errs,
                countIfMerge(warn_count)           AS warns,
                countIfMerge(new_template_count)   AS new_tmpls
              FROM logweave.service_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY tenant_id`,
      query_params: { tenant_id: tenant },
    })
    const [row] = await result.json<{
      total: string
      errs: string
      warns: string
      new_tmpls: string
    }>()

    assert.equal(row.total, '3', 'All 3 rows should be counted')
    assert.equal(row.errs, '1', '1 ERROR row')
    assert.equal(row.warns, '1', '1 WARN row')
    assert.equal(row.new_tmpls, '1', '1 new template')
  })
})
