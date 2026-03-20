import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import request from 'supertest'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { queryTemplateSearch } from '../../src/db/dashboard-queries.js'
import { createAuthMiddleware } from '../../src/middleware/auth.js'
import { createErrorHandler } from '../../src/middleware/error-handler.js'
import { dashboardRoutes } from '../../src/routes/dashboard.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_KEY = 'test-api-key'
const TENANT_A = 'tenant-a'
const keyMap = new Map([[TEST_KEY, TENANT_A]])

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockSearchResults = [
  {
    template_id: 'tmpl-timeout-1',
    template_text: 'Connection to <IP> timed out after <ID>ms',
    services_affected: ['api', 'worker'],
    occurrence_count: '150',
    error_count: '150',
    avg_duration_ms: '5000.5',
    max_anomaly_score: '2.1',
    first_seen: '2026-03-15T00:00:00.000Z',
    last_seen: '2026-03-20T14:00:00.000Z',
  },
  {
    template_id: 'tmpl-timeout-2',
    template_text: 'Query timed out on table <*>',
    services_affected: ['api'],
    occurrence_count: '30',
    error_count: '30',
    avg_duration_ms: '30100.0',
    max_anomaly_score: '0.5',
    first_seen: '2026-03-18T00:00:00.000Z',
    last_seen: '2026-03-20T12:00:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// Mock DbClient
// ---------------------------------------------------------------------------

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

function createMockDb(queryResults?: Map<string, unknown>): DbClient {
  return {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      if (queryResults) {
        for (const [key, value] of queryResults) {
          if (params.query.includes(key)) return value
        }
      }
      return []
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

function createTestApp(queryResults?: Map<string, unknown>) {
  const logger = pino({ level: 'silent' })
  const db = createMockDb(queryResults)
  const app = express()
  app.use(express.json())
  const auth = createAuthMiddleware(keyMap)
  app.use('/v1', auth, dashboardRoutes({ db, logger }))
  app.use(createErrorHandler(logger))
  return app
}

function searchQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('ILIKE', mockSearchResults)
  // Provide empty results for other queries that might fire (new today etc.)
  map.set('is_new_template', [])
  return map
}

// ---------------------------------------------------------------------------
// Direct query function tests
// ---------------------------------------------------------------------------

describe('queryTemplateSearch', () => {
  it('finds templates matching text', async () => {
    const { db, captured } = createCapturingDb(mockSearchResults)

    const results = await queryTemplateSearch(db, 'tenant-a', { q: 'timeout' })

    assert.equal(results.length, 2)
    assert.equal(captured.length, 1)
    const sql = captured[0].query
    assert.ok(sql.includes('ILIKE'), 'should use ILIKE for search')
    assert.ok(sql.includes('template_registry FINAL'), 'should use SELECT ... FINAL on registry')
  })

  it('case insensitive via ILIKE', async () => {
    const { db, captured } = createCapturingDb(mockSearchResults)

    await queryTemplateSearch(db, 'tenant-a', { q: 'TIMEOUT' })

    assert.equal(captured[0].query_params.search_pattern, '%TIMEOUT%')
    assert.ok(captured[0].query.includes('ILIKE'), 'should use ILIKE for case-insensitive search')
  })

  it('returns occurrence counts from template_stats', async () => {
    const { db, captured } = createCapturingDb(mockSearchResults)

    await queryTemplateSearch(db, 'tenant-a', { q: 'timeout' })

    const sql = captured[0].query
    assert.ok(sql.includes('template_stats'), 'should join to template_stats for counts')
    assert.ok(sql.includes('countMerge(s.occurrence_count)'), 'should aggregate occurrence counts')
  })

  it('includes servicesAffected', async () => {
    const { db, captured } = createCapturingDb(mockSearchResults)

    await queryTemplateSearch(db, 'tenant-a', { q: 'timeout' })

    const sql = captured[0].query
    assert.ok(sql.includes('groupArray(DISTINCT s.service)'), 'should group services')
  })

  it('respects tenant isolation', async () => {
    const { db, captured } = createCapturingDb(mockSearchResults)

    await queryTemplateSearch(db, 'tenant-xyz', { q: 'timeout' })

    assert.equal(captured[0].query_params.tenant_id, 'tenant-xyz')
    // Verify tenant filter appears in BOTH the registry CTE and the stats join
    const sql = captured[0].query
    const tenantMatches = sql.match(/tenant_id = \{tenant_id:String\}/g)
    assert.ok(tenantMatches && tenantMatches.length >= 2, 'tenant filter in both registry and stats')
  })

  it('returns empty array for no matches', async () => {
    const { db } = createCapturingDb([])

    const results = await queryTemplateSearch(db, 'tenant-a', { q: 'nonexistent' })

    assert.deepEqual(results, [])
  })

  it('parameterised query prevents injection', async () => {
    const { db, captured } = createCapturingDb([])

    await queryTemplateSearch(db, 'tenant-a', { q: "'; DROP TABLE--" })

    const sql = captured[0].query
    // The malicious string should NOT appear in the SQL — it's in search_pattern param
    assert.ok(!sql.includes('DROP TABLE'), 'SQL should not contain injected text')
    assert.equal(captured[0].query_params.search_pattern, "%'; DROP TABLE--%")
  })

  it('wraps query in % wildcards for substring match', async () => {
    const { db, captured } = createCapturingDb([])

    await queryTemplateSearch(db, 'tenant-a', { q: 'database' })

    assert.equal(captured[0].query_params.search_pattern, '%database%')
  })
})

// ---------------------------------------------------------------------------
// Route-level tests
// ---------------------------------------------------------------------------

describe('GET /v1/templates/search', () => {
  it('returns correct shape with data + meta envelope', async () => {
    const app = createTestApp(searchQueryMap())

    const res = await request(app)
      .get('/v1/templates/search?q=timeout')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data))
    assert.equal(res.body.data.length, 2)
    assert.ok(res.body.meta)
    assert.equal(typeof res.body.meta.hours, 'number')
    assert.equal(typeof res.body.meta.count, 'number')
    assert.equal(res.body.meta.count, 2)
  })

  it('maps response fields correctly', async () => {
    const app = createTestApp(searchQueryMap())

    const res = await request(app)
      .get('/v1/templates/search?q=timeout')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    const first = res.body.data[0]
    assert.equal(first.templateId, 'tmpl-timeout-1')
    assert.equal(first.templateText, 'Connection to <IP> timed out after <ID>ms')
    assert.deepEqual(first.servicesAffected, ['api', 'worker'])
    assert.equal(first.occurrenceCount, 150)
    assert.equal(first.errorCount, 150)
    assert.equal(typeof first.avgDurationMs, 'number')
    assert.equal(typeof first.maxAnomalyScore, 'number')
  })

  it('rejects query under 3 characters', async () => {
    const app = createTestApp(searchQueryMap())

    const res = await request(app)
      .get('/v1/templates/search?q=ab')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('rejects missing q parameter', async () => {
    const app = createTestApp(searchQueryMap())

    const res = await request(app)
      .get('/v1/templates/search')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp(searchQueryMap())

    const res = await request(app).get('/v1/templates/search?q=timeout')

    assert.equal(res.status, 401)
  })

  it('returns empty array for no matches', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/templates/search?q=nonexistent')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
    assert.equal(res.body.meta.count, 0)
  })
})
