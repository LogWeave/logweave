import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../src/db/client.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { compositeRoutes } from '../src/routes/composite.js'
import { dashboardRoutes } from '../src/routes/dashboard.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_KEY = 'test-api-key'
const TENANT_A = 'tenant-a'
const keyMap = new Map([[TEST_KEY, TENANT_A]])

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockCrossServiceRows = [
  {
    template_id: 'tmpl-1',
    template_text: 'Connection timeout to <IP>',
    services_affected: ['api', 'worker'],
    occurrence_count: '200',
    error_count: '200',
    avg_duration_ms: '5000.0',
    max_anomaly_score: '2.5',
    first_seen: '2026-03-17T00:00:00.000Z',
    last_seen: '2026-03-20T14:00:00.000Z',
  },
  {
    template_id: 'tmpl-2',
    template_text: 'Rate limit exceeded',
    services_affected: ['api'],
    occurrence_count: '50',
    error_count: '50',
    avg_duration_ms: '12.0',
    max_anomaly_score: '0.3',
    first_seen: '2026-03-18T00:00:00.000Z',
    last_seen: '2026-03-20T12:00:00.000Z',
  },
]

const mockSparklineRows = [
  { template_id: 'tmpl-1', interval_start: '2026-03-20T12:00:00.000Z', count: '30' },
  { template_id: 'tmpl-1', interval_start: '2026-03-20T13:00:00.000Z', count: '45' },
]

const mockStatusCodeRows = [
  { status_code: '500', count: '180' },
  { status_code: '503', count: '20' },
]

const mockServiceRows = [
  {
    service: 'api',
    log_count: '10000',
    error_count: '200',
    warn_count: '500',
    new_template_count: '3',
    avg_anomaly_score: '0.4',
  },
]

const mockVolumeRows = [
  { interval_start: '2026-03-20T12:00:00.000Z', service: 'api', log_count: '500', error_count: '10' },
  { interval_start: '2026-03-20T13:00:00.000Z', service: 'api', log_count: '600', error_count: '15' },
]

const mockOverviewAggRow = {
  total_events: '50000',
  error_count: '1000',
  warn_count: '2500',
  new_template_count: '7',
}

const mockOverviewCountsRow = {
  unique_templates: '120',
  unclustered_count: '30',
  service_count: '8',
}

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

const QUERY_NAME_RE = /@query:\s*(\w+)/

function extractQueryName(sql: string): string | undefined {
  return QUERY_NAME_RE.exec(sql)?.[1]
}

function createMockDb(queryResults?: Map<string, unknown>): DbClient {
  return {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      if (!queryResults) return []
      const name = extractQueryName(params.query)
      if (name && queryResults.has(name)) return queryResults.get(name)
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
  app.use('/v1', auth, dashboardRoutes({ db, logger }), compositeRoutes({ db, logger }))
  app.use(createErrorHandler(logger))
  return app
}

// ---------------------------------------------------------------------------
// Mock query maps
// ---------------------------------------------------------------------------

function templateDetailQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('templatesAcrossServices', mockCrossServiceRows)
  map.set('templateSparklines', mockSparklineRows)
  map.set('templateStatusCodes', mockStatusCodeRows)
  return map
}

function serviceHealthQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('dashboardServices', mockServiceRows)
  map.set('templatesAcrossServices', mockCrossServiceRows)
  map.set('dashboardVolume', mockVolumeRows)
  return map
}

function overviewQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('overviewAggregates', [mockOverviewAggRow])
  map.set('overviewCounts', [mockOverviewCountsRow])
  map.set('templatesAcrossServices', mockCrossServiceRows)
  return map
}

// ---------------------------------------------------------------------------
// Template Detail Composite
// ---------------------------------------------------------------------------

describe('GET /v1/templates/:id/detail', () => {
  it('returns all fields in single response', async () => {
    const app = createTestApp(templateDetailQueryMap())

    const res = await request(app)
      .get('/v1/templates/tmpl-1/detail')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const data = res.body.data
    assert.equal(data.templateId, 'tmpl-1')
    assert.equal(data.templateText, 'Connection timeout to <IP>')
    assert.deepEqual(data.servicesAffected, ['api', 'worker'])
    assert.equal(data.occurrenceCount, 200)
    assert.equal(data.errorCount, 200)
    assert.equal(typeof data.avgDurationMs, 'number')
    assert.equal(typeof data.maxAnomalyScore, 'number')
    assert.ok(data.firstSeen)
    assert.ok(data.lastSeen)
    assert.ok(Array.isArray(data.sparkline), 'should include sparkline')
    assert.equal(data.sparkline.length, 2)
    assert.ok(Array.isArray(data.statusCodes), 'should include statusCodes')
    assert.equal(data.statusCodes.length, 2)
  })

  it('parallelises queries (returns sparkline + statusCodes)', async () => {
    const app = createTestApp(templateDetailQueryMap())

    const res = await request(app)
      .get('/v1/templates/tmpl-1/detail')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    // Verify sparkline data
    assert.equal(res.body.data.sparkline[0].intervalStart, '2026-03-20T12:00:00.000Z')
    assert.equal(res.body.data.sparkline[0].count, 30)
    // Verify status code data
    assert.equal(res.body.data.statusCodes[0].statusCode, 500)
    assert.equal(res.body.data.statusCodes[0].count, 180)
  })

  it('returns 404 for unknown template', async () => {
    const app = createTestApp(templateDetailQueryMap())

    const res = await request(app)
      .get('/v1/templates/nonexistent/detail')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'NOT_FOUND')
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp(templateDetailQueryMap())
    const res = await request(app).get('/v1/templates/tmpl-1/detail')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// Service Health Composite
// ---------------------------------------------------------------------------

describe('GET /v1/services/:name/health', () => {
  it('includes top error patterns and volume trend', async () => {
    const app = createTestApp(serviceHealthQueryMap())

    const res = await request(app)
      .get('/v1/services/api/health')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const data = res.body.data
    assert.equal(data.service, 'api')
    assert.equal(data.logCount, 10000)
    assert.equal(data.errorCount, 200)
    assert.equal(data.warnCount, 500)
    assert.equal(data.errorRate, 0.02)
    assert.equal(data.warnRate, 0.05)
    assert.ok(Array.isArray(data.topErrorPatterns), 'should include topErrorPatterns')
    assert.ok(Array.isArray(data.volumeTrend), 'should include volumeTrend')
    assert.equal(data.volumeTrend.length, 2)
  })

  it('returns 404 for unknown service', async () => {
    const app = createTestApp(serviceHealthQueryMap())

    const res = await request(app)
      .get('/v1/services/nonexistent/health')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'NOT_FOUND')
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp(serviceHealthQueryMap())
    const res = await request(app).get('/v1/services/api/health')
    assert.equal(res.status, 401)
  })

  // Bug #168 regression: topErrorPatterns must always use ['ERROR'], even when
  // the user passes ?level=. Previously the route did [...levels, 'ERROR'],
  // so ?level=DEBUG returned DEBUG patterns alongside ERROR.
  it('topErrorPatterns is hard-coded to ERROR regardless of ?level filter', async () => {
    const queryMap = serviceHealthQueryMap()
    const captured: Array<Record<string, unknown>> = []
    const logger = pino({ level: 'silent' })
    const db = {
      query: async (params: { query: string; query_params: Record<string, unknown> }) => {
        const name = extractQueryName(params.query)
        if (name === 'templatesAcrossServices') {
          captured.push(params.query_params)
        }
        if (name && queryMap.has(name)) return queryMap.get(name)
        return []
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient
    const app = express()
    app.use(express.json())
    const auth = createAuthMiddleware(keyMap)
    app.use('/v1', auth, dashboardRoutes({ db, logger }), compositeRoutes({ db, logger }))
    app.use(createErrorHandler(logger))

    const res = await request(app)
      .get('/v1/services/api/health?level=DEBUG,INFO')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(captured.length, 1, 'expected one cross-service template query')
    assert.deepEqual(captured[0]!.levels, ['ERROR'])
  })
})

// ---------------------------------------------------------------------------
// Overview Composite
// ---------------------------------------------------------------------------

describe('GET /v1/overview', () => {
  it('includes top 5 cross-service error patterns', async () => {
    const app = createTestApp(overviewQueryMap())

    const res = await request(app)
      .get('/v1/overview')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const data = res.body.data
    assert.equal(data.totalEvents, 50000)
    assert.equal(data.totalTemplates, 120)
    assert.equal(data.newTemplatesToday, 7)
    assert.equal(data.unclusteredCount, 30)
    assert.equal(data.errorRate, 0.02)
    assert.equal(data.serviceCount, 8)
    assert.ok(Array.isArray(data.topErrorPatterns), 'should include topErrorPatterns')
    assert.equal(data.topErrorPatterns.length, 2)
    assert.equal(data.topErrorPatterns[0].templateId, 'tmpl-1')
    assert.deepEqual(data.topErrorPatterns[0].servicesAffected, ['api', 'worker'])
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp(overviewQueryMap())
    const res = await request(app).get('/v1/overview')
    assert.equal(res.status, 401)
  })

  it('includes meta envelope', async () => {
    const app = createTestApp(overviewQueryMap())

    const res = await request(app)
      .get('/v1/overview?hours=12')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 12)
    assert.equal(typeof res.body.meta.fetchedAt, 'string')
  })

  // Bug #168 regression: same as service-health — overview's topErrorPatterns
  // must always query level=['ERROR'] only.
  it('topErrorPatterns is hard-coded to ERROR regardless of ?level filter', async () => {
    const queryMap = overviewQueryMap()
    const captured: Array<Record<string, unknown>> = []
    const logger = pino({ level: 'silent' })
    const db = {
      query: async (params: { query: string; query_params: Record<string, unknown> }) => {
        const name = extractQueryName(params.query)
        if (name === 'templatesAcrossServices') {
          captured.push(params.query_params)
        }
        if (name && queryMap.has(name)) return queryMap.get(name)
        return []
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient
    const app = express()
    app.use(express.json())
    const auth = createAuthMiddleware(keyMap)
    app.use('/v1', auth, dashboardRoutes({ db, logger }), compositeRoutes({ db, logger }))
    app.use(createErrorHandler(logger))

    const res = await request(app)
      .get('/v1/overview?level=INFO,DEBUG')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(captured.length, 1, 'expected one cross-service template query')
    assert.deepEqual(captured[0]!.levels, ['ERROR'])
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

describe('composite endpoints: tenant isolation', () => {
  it('all composites require auth', async () => {
    const app = createTestApp(templateDetailQueryMap())

    const endpoints = [
      '/v1/templates/tmpl-1/detail',
      '/v1/services/api/health',
      '/v1/overview',
    ]

    for (const endpoint of endpoints) {
      const res = await request(app).get(endpoint)
      assert.equal(res.status, 401, `${endpoint} should require auth`)
    }
  })
})
