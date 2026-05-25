import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DbClient } from '../../src/db/client.js'
import { queryTemplatesAcrossServices } from '../../src/db/dashboard/templates.js'

// ---------------------------------------------------------------------------
// Mock data — ClickHouse returns numbers as strings in JSONEachRow
// ---------------------------------------------------------------------------

const mockCrossServiceRows = [
  {
    template_id: 'tmpl-1',
    template_text: 'Connection to <IP> timed out',
    services_affected: ['api', 'worker', 'scheduler'],
    occurrence_count: '250',
    error_count: '250',
    avg_duration_ms: '5012.3',
    max_anomaly_score: '3.2',
    first_seen: '2026-03-15T00:00:00.000Z',
    last_seen: '2026-03-20T14:00:00.000Z',
  },
  {
    template_id: 'tmpl-2',
    template_text: 'Request processed in <ID>ms',
    services_affected: ['api'],
    occurrence_count: '100',
    error_count: '0',
    avg_duration_ms: '45.7',
    max_anomaly_score: '0.1',
    first_seen: '2026-03-14T00:00:00.000Z',
    last_seen: '2026-03-20T13:00:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// Mock DbClient
// ---------------------------------------------------------------------------

function createMockDb(
  capturedQueries: Array<{ query: string; query_params: Record<string, unknown> }>,
): DbClient {
  return {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      capturedQueries.push(params)
      return mockCrossServiceRows
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queryTemplatesAcrossServices', () => {
  it('groups templates across services with groupArray(DISTINCT service)', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    const results = await queryTemplatesAcrossServices(db, 'tenant-a')

    assert.equal(results.length, 2)
    assert.equal(captured.length, 1)

    const sql = captured[0].query
    assert.ok(
      sql.includes('groupArray(DISTINCT service)'),
      'should use groupArray(DISTINCT service)',
    )
    assert.ok(
      sql.includes('GROUP BY template_id, template_text'),
      'should group by template_id, template_text',
    )
    assert.ok(
      !sql.includes('GROUP BY template_id, template_text, service'),
      'should NOT include service in GROUP BY',
    )
  })

  it('servicesAffected contains all unique services', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    const results = await queryTemplatesAcrossServices(db, 'tenant-a')

    assert.deepEqual(results[0].services_affected, ['api', 'worker', 'scheduler'])
    assert.deepEqual(results[1].services_affected, ['api'])
  })

  it('aggregates counts correctly across services', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    const _results = await queryTemplatesAcrossServices(db, 'tenant-a')

    const sql = captured[0].query
    assert.ok(sql.includes('countMerge(occurrence_count)'), 'should aggregate occurrence_count')
    assert.ok(sql.includes('countMerge(error_count)'), 'should aggregate error_count')
    assert.ok(sql.includes('avgMerge(avg_duration_ms)'), 'should aggregate avg_duration_ms')
    assert.ok(sql.includes('maxMerge(max_anomaly_score)'), 'should aggregate max_anomaly_score')
  })

  it('respects tenant isolation', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    await queryTemplatesAcrossServices(db, 'tenant-xyz')

    assert.equal(captured[0].query_params.tenant_id, 'tenant-xyz')
    assert.ok(captured[0].query.includes('tenant_id = {tenant_id:String}'))
  })

  it('filters by level when provided', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    await queryTemplatesAcrossServices(db, 'tenant-a', { level: ['ERROR', 'WARN'] })

    const sql = captured[0].query
    assert.ok(sql.includes('level IN'), 'should include level filter')
    assert.deepEqual(captured[0].query_params.levels, ['ERROR', 'WARN'])
  })

  it('filters by service when provided', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    await queryTemplatesAcrossServices(db, 'tenant-a', { service: 'api' })

    assert.ok(captured[0].query.includes('service = {service:String}'))
    assert.equal(captured[0].query_params.service, 'api')
  })

  it('uses default hours and limit when not specified', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    await queryTemplatesAcrossServices(db, 'tenant-a')

    assert.equal(captured[0].query_params.hours, 24)
    assert.equal(captured[0].query_params.limit, 100)
  })

  it('clamps hours to MAX_HOURS', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    await queryTemplatesAcrossServices(db, 'tenant-a', { hours: 9999 })

    assert.equal(captured[0].query_params.hours, 720)
  })

  it('query is fully parameterised', async () => {
    const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
    const db = createMockDb(captured)

    await queryTemplatesAcrossServices(db, 'tenant-a', {
      hours: 48,
      limit: 50,
      service: 'api',
      level: ['ERROR'],
    })

    const sql = captured[0].query
    // Verify no string interpolation of user values — all should be parameterised
    assert.ok(!sql.includes("'tenant-a'"), 'tenant_id should be parameterised, not interpolated')
    assert.ok(!sql.includes("'api'"), 'service should be parameterised, not interpolated')
    assert.ok(!sql.includes("'ERROR'"), 'level should be parameterised, not interpolated')
  })
})
