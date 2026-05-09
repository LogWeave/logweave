import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import { batchInsert } from '../../src/db/insert.js'
import { initSchema } from '../../src/db/schema.js'
import type { LogMetadataRow } from '../../src/types.js'
import { closeTestClient, getTestClient, getTestDb, jsonRows, testTenantId } from './helpers.js'

const logger = pino({ level: 'silent' })

interface TemplateStatsRow {
  template_id: string
  cnt: number | string
}

interface AvgRow {
  avg_dur: number
}

interface ErrorCountRow {
  errs: number | string
}

interface ServiceStatsRow {
  total: number | string
  errs: number | string
  warns: number | string
  new_tmpls: number | string
}

interface ServiceStats5mRow {
  total: number | string
  errs: number | string
  warns: number | string
}

// template_stats and service_stats have a 30-day TTL — a fixed past date goes
// stale and rows get TTL'd away during OPTIMIZE FINAL. Always use recent.
function recentTs(): string {
  return new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').replace('Z', '')
}

function makeRow(tenantId: string, overrides?: Partial<LogMetadataRow>): LogMetadataRow {
  return {
    tenant_id: tenantId,
    timestamp: recentTs(),
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
  const db = getTestDb()

  before(async () => {
    await initSchema(client, logger)
  })

  after(async () => {
    await closeTestClient()
  })

  it('template_stats MV excludes unclustered rows (template_id=0)', async () => {
    const tenant = testTenantId('mv-exclude')

    await batchInsert(db, [
      makeRow(tenant, { template_id: 'tmpl-real', template_text: 'Real template' }),
      makeRow(tenant, { template_id: '0', template_text: '' }),
    ])

    await client.command({ query: 'OPTIMIZE TABLE logweave.template_stats FINAL' })

    const result = await client.query({
      query: `SELECT template_id,
                     countMerge(occurrence_count) AS cnt
              FROM logweave.template_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY template_id`,
      query_params: { tenant_id: tenant },
    })
    const rows = await jsonRows<TemplateStatsRow>(result)

    assert.equal(rows.length, 1, 'Only clustered rows should appear')
    const first = rows[0]
    assert.ok(first, 'Expected at least one row')
    assert.equal(first.template_id, 'tmpl-real')
    assert.equal(Number(first.cnt), 1)
  })

  it('avgMerge produces correct results after OPTIMIZE', async () => {
    const tenant = testTenantId('mv-avg')

    await batchInsert(db, [
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
    const rows = await jsonRows<AvgRow>(result)
    const first = rows[0]
    assert.ok(first, 'Expected at least one row')

    assert.ok(Math.abs(first.avg_dur - 200) < 0.01, `Expected avg ≈ 200, got ${first.avg_dur}`)
  })

  it('avgMerge produces correct results WITHOUT OPTIMIZE (production read path)', async () => {
    const tenant = testTenantId('mv-no-optimize')

    await batchInsert(db, [
      makeRow(tenant, { duration_ms: 50 }),
      makeRow(tenant, { duration_ms: 150 }),
    ])

    const result = await client.query({
      query: `SELECT avgMerge(avg_duration_ms) AS avg_dur
              FROM logweave.template_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY tenant_id`,
      query_params: { tenant_id: tenant },
    })
    const rows = await jsonRows<AvgRow>(result)
    const first = rows[0]
    assert.ok(first, 'Expected at least one row')

    assert.ok(Math.abs(first.avg_dur - 100) < 0.01, `Expected avg ≈ 100, got ${first.avg_dur}`)
  })

  it('countMerge correctly counts ERROR rows in template_stats', async () => {
    const tenant = testTenantId('mv-errors')

    await batchInsert(db, [
      makeRow(tenant, { level: 'ERROR' }),
      makeRow(tenant, { level: 'ERROR' }),
      makeRow(tenant, { level: 'INFO' }),
    ])

    await client.command({ query: 'OPTIMIZE TABLE logweave.template_stats FINAL' })

    const result = await client.query({
      query: `SELECT countMerge(error_count) AS errs
              FROM logweave.template_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY tenant_id`,
      query_params: { tenant_id: tenant },
    })
    const rows = await jsonRows<ErrorCountRow>(result)
    const first = rows[0]
    assert.ok(first, 'Expected at least one row')
    assert.equal(Number(first.errs), 2)
  })

  it('service_stats MV counts all rows including unclustered', async () => {
    const tenant = testTenantId('mv-service')

    await batchInsert(db, [
      makeRow(tenant, { template_id: 'real-1', level: 'ERROR' }),
      makeRow(tenant, { template_id: '0', level: 'WARN' }),
      makeRow(tenant, { template_id: 'real-2', level: 'INFO', is_new_template: 1 }),
    ])

    await client.command({ query: 'OPTIMIZE TABLE logweave.service_stats FINAL' })

    const result = await client.query({
      query: `SELECT
                countMerge(log_count)            AS total,
                countMerge(error_count)         AS errs,
                countMerge(warn_count)           AS warns,
                countMerge(new_template_count)   AS new_tmpls
              FROM logweave.service_stats
              WHERE tenant_id = {tenant_id:String}
              GROUP BY tenant_id`,
      query_params: { tenant_id: tenant },
    })
    const rows = await jsonRows<ServiceStatsRow>(result)
    const row = rows[0]
    assert.ok(row, 'Expected at least one row')

    assert.equal(Number(row.total), 3, 'All 3 rows should be counted')
    assert.equal(Number(row.errs), 1, '1 ERROR row')
    assert.equal(Number(row.warns), 1, '1 WARN row')
    assert.equal(Number(row.new_tmpls), 1, '1 new template')
  })

  it('service_stats_5m MV aggregates 5-minute buckets', async () => {
    const tenant = testTenantId('mv-5m')
    // Use a recent timestamp — service_stats_5m has 7-day TTL, so OPTIMIZE would
    // drop rows older than 7 days during the merge.
    const recentTs = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').replace('Z', '')

    await batchInsert(db, [
      makeRow(tenant, { template_id: 'real-1', level: 'ERROR', timestamp: recentTs }),
      makeRow(tenant, { template_id: '0', level: 'WARN', timestamp: recentTs }),
      makeRow(tenant, { template_id: 'real-2', level: 'INFO', timestamp: recentTs }),
    ])

    await client.command({ query: 'OPTIMIZE TABLE logweave.service_stats_5m FINAL' })

    const result = await client.query({
      query: `SELECT
                countMerge(log_count)    AS total,
                countMerge(error_count)  AS errs,
                countMerge(warn_count)   AS warns
              FROM logweave.service_stats_5m
              WHERE tenant_id = {tenant_id:String}
              GROUP BY tenant_id`,
      query_params: { tenant_id: tenant },
    })
    const rows = await jsonRows<ServiceStats5mRow>(result)
    const row = rows[0]
    assert.ok(row, 'Expected at least one row')

    assert.equal(Number(row.total), 3, 'All 3 rows should be counted')
    assert.equal(Number(row.errs), 1, '1 ERROR row')
    assert.equal(Number(row.warns), 1, '1 WARN row')
  })
})
