import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DbClient } from '../../src/db/client.js'
import { queryTemplateTrend } from '../../src/db/dashboard-queries.js'

function createCapturingDb(
  mockData: unknown = [],
): { db: DbClient; captured: Array<{ query: string; query_params: Record<string, unknown> }> } {
  const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
  const db = {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      captured.push(params)
      return mockData
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, captured }
}

const MOCK_TREND_DATA = [
  { day: '2026-03-20', occurrence_count: '100', error_count: '5', avg_duration_ms: '200.0', max_anomaly_score: '0.8' },
  { day: '2026-03-21', occurrence_count: '150', error_count: '10', avg_duration_ms: '250.0', max_anomaly_score: '1.2' },
  { day: '2026-03-22', occurrence_count: '80', error_count: '2', avg_duration_ms: '180.0', max_anomaly_score: '0.3' },
]

describe('queryTemplateTrend', () => {
  it('queries template_daily_summary with correct table', async () => {
    const { db, captured } = createCapturingDb(MOCK_TREND_DATA)

    await queryTemplateTrend(db, 'tenant-a', { templateId: 'tmpl-1' })

    assert.equal(captured.length, 1)
    const sql = captured[0].query
    assert.ok(sql.includes('template_daily_summary'), 'should query daily summary table')
    assert.ok(sql.includes('countMerge'), 'should use countMerge on aggregate functions')
  })

  it('respects tenant isolation', async () => {
    const { db, captured } = createCapturingDb([])

    await queryTemplateTrend(db, 'tenant-xyz', { templateId: 'tmpl-1' })

    assert.equal(captured[0].query_params.tenant_id, 'tenant-xyz')
    const sql = captured[0].query
    assert.ok(sql.includes('tenant_id = {tenant_id:String}'))
  })

  it('passes template_id parameter', async () => {
    const { db, captured } = createCapturingDb([])

    await queryTemplateTrend(db, 'tenant-a', { templateId: 'tmpl-abc' })

    assert.equal(captured[0].query_params.template_id, 'tmpl-abc')
    assert.ok(captured[0].query.includes('template_id = {template_id:String}'))
  })

  it('defaults to 90 days', async () => {
    const { db, captured } = createCapturingDb([])

    await queryTemplateTrend(db, 'tenant-a', { templateId: 'tmpl-1' })

    assert.equal(captured[0].query_params.days, 90)
  })

  it('accepts custom days parameter', async () => {
    const { db, captured } = createCapturingDb([])

    await queryTemplateTrend(db, 'tenant-a', { templateId: 'tmpl-1', days: 30 })

    assert.equal(captured[0].query_params.days, 30)
  })

  it('clamps days to max 365', async () => {
    const { db, captured } = createCapturingDb([])

    await queryTemplateTrend(db, 'tenant-a', { templateId: 'tmpl-1', days: 999 })

    assert.equal(captured[0].query_params.days, 365)
  })

  it('returns trend rows', async () => {
    const { db } = createCapturingDb(MOCK_TREND_DATA)

    const rows = await queryTemplateTrend(db, 'tenant-a', { templateId: 'tmpl-1' })

    assert.equal(rows.length, 3)
    assert.equal(rows[0].day, '2026-03-20')
    assert.equal(rows[0].occurrence_count, '100')
  })

  it('orders by day ascending', async () => {
    const { db, captured } = createCapturingDb([])

    await queryTemplateTrend(db, 'tenant-a', { templateId: 'tmpl-1' })

    assert.ok(captured[0].query.includes('ORDER BY day ASC'))
  })
})
