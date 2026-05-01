import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express, { Router } from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../src/db/client.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createConcurrentQueryGuard } from '../src/middleware/concurrent-query-guard.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { createRateLimiter } from '../src/middleware/rate-limit.js'
import { correlationRoutes } from '../src/routes/correlation.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_A = 'key-a'
const TENANT_A = 'tenant-a'
const keyMap = new Map([[KEY_A, TENANT_A]])

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockTraceEvents = [
  {
    service: 'api-gateway',
    template_id: '019abc-1',
    template_text: 'GET /users <*>',
    level: 'INFO',
    timestamp: '2026-03-20T10:00:00.000Z',
    status_code: '200',
    duration_ms: '45.2',
    route: '/users/:id',
  },
  {
    service: 'user-service',
    template_id: '019abc-2',
    template_text: 'Query user by id <*>',
    level: 'INFO',
    timestamp: '2026-03-20T10:00:00.050Z',
    status_code: '200',
    duration_ms: '12.5',
    route: '',
  },
  {
    service: 'user-service',
    template_id: '019abc-3',
    template_text: 'Database timeout connecting to <*>',
    level: 'ERROR',
    timestamp: '2026-03-20T10:00:00.100Z',
    status_code: '500',
    duration_ms: '5003.1',
    route: '',
  },
]

const mockRelatedPatterns = [
  {
    template_id: '019abc-10',
    template_text: 'Connection pool exhausted',
    service: 'db-proxy',
    co_occurrence_count: '42',
  },
  {
    template_id: '019abc-11',
    template_text: 'Retry attempt <*> for <*>',
    service: 'api-gateway',
    co_occurrence_count: '28',
  },
]

const mockCorrelations = [
  {
    template_id: '019abc-20',
    template_text: 'Connection reset by peer',
    coefficient: '0.923',
    occurrence_count: '1500',
  },
  {
    template_id: '019abc-21',
    template_text: 'Upstream timeout after <*>ms',
    coefficient: '-0.812',
    occurrence_count: '890',
  },
]

const mockOutlierRow = {
  data_points: '168',
  baseline_mean: '5.2',
  baseline_stddev: '1.8',
  current_rate: '12.0',
  current_errors: '12',
  current_logs: '500',
}

// ---------------------------------------------------------------------------
// Mock DbClient
// ---------------------------------------------------------------------------

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
  const v1 = Router()
  v1.use(createAuthMiddleware(new Map(keyMap)))
  v1.use(createRateLimiter({ keyRpm: 1000, tenantRpm: 2000, ingestKeyRpm: 3000 }))
  v1.use(createConcurrentQueryGuard({ maxConcurrent: 100 }))
  v1.use(correlationRoutes({ db, logger }))
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return app
}

// ---------------------------------------------------------------------------
// GET /v1/traces/:traceId
// ---------------------------------------------------------------------------

describe('GET /v1/traces/:traceId', () => {
  function traceQueryMap(): Map<string, unknown> {
    const map = new Map<string, unknown>()
    map.set('trace_id = {trace_id:String}', mockTraceEvents)
    return map
  }

  it('returns chronologically ordered events for a trace', async () => {
    const app = createTestApp(traceQueryMap())

    const res = await request(app)
      .get('/v1/traces/abc-123-def')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 3)
    assert.equal(res.body.data[0].service, 'api-gateway')
    assert.equal(res.body.data[0].templateId, '019abc-1')
    assert.equal(res.body.data[2].level, 'ERROR')
    assert.equal(res.body.meta.count, 3)
    assert.ok(res.body.meta.fetchedAt)
    assert.ok(res.body.meta.timeRange)
    assert.ok(res.body.meta.dataRetention)
  })

  it('casts numeric fields from ClickHouse strings', async () => {
    const app = createTestApp(traceQueryMap())

    const res = await request(app)
      .get('/v1/traces/abc-123-def')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(typeof res.body.data[0].statusCode, 'number')
    assert.equal(res.body.data[0].statusCode, 200)
    assert.equal(typeof res.body.data[0].durationMs, 'number')
    assert.equal(res.body.data[0].durationMs, 45.2)
  })

  it('returns 404 for unknown trace_id', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/traces/nonexistent')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'NOT_FOUND')
  })

  it('accepts hours query param', async () => {
    const app = createTestApp(traceQueryMap())

    const res = await request(app)
      .get('/v1/traces/abc-123-def?hours=48')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 48)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp(traceQueryMap())
    const res = await request(app).get('/v1/traces/abc-123')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/templates/:id/related
// ---------------------------------------------------------------------------

describe('GET /v1/templates/:id/related', () => {
  function relatedQueryMap(): Map<string, unknown> {
    const map = new Map<string, unknown>()
    map.set('INNER JOIN matching_traces', mockRelatedPatterns)
    return map
  }

  it('returns co-occurring patterns', async () => {
    const app = createTestApp(relatedQueryMap())

    const res = await request(app)
      .get('/v1/templates/019abc-1/related')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 2)
    assert.equal(res.body.data[0].templateId, '019abc-10')
    assert.equal(res.body.data[0].templateText, 'Connection pool exhausted')
    assert.equal(res.body.data[0].service, 'db-proxy')
    assert.equal(res.body.data[0].coOccurrenceCount, 42)
    assert.equal(res.body.meta.count, 2)
  })

  it('returns empty array when no related patterns found', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/templates/019abc-1/related')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
    assert.equal(res.body.meta.count, 0)
  })

  it('accepts hours and limit params', async () => {
    const app = createTestApp(relatedQueryMap())

    const res = await request(app)
      .get('/v1/templates/019abc-1/related?hours=48&limit=5')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 48)
    assert.equal(res.body.meta.limit, 5)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp()
    const res = await request(app).get('/v1/templates/019abc-1/related')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/templates/:id/correlations
// ---------------------------------------------------------------------------

describe('GET /v1/templates/:id/correlations', () => {
  function correlationQueryMap(): Map<string, unknown> {
    const map = new Map<string, unknown>()
    map.set('corr(a.cnt, c.cnt)', mockCorrelations)
    return map
  }

  it('returns correlated templates with coefficient and direction', async () => {
    const app = createTestApp(correlationQueryMap())

    const res = await request(app)
      .get('/v1/templates/019abc-1/correlations')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 2)

    const first = res.body.data[0]
    assert.equal(first.templateId, '019abc-20')
    assert.equal(first.coefficient, 0.923)
    assert.equal(first.direction, 'positive')
    assert.equal(first.occurrenceCount, 1500)

    const second = res.body.data[1]
    assert.equal(second.coefficient, -0.812)
    assert.equal(second.direction, 'negative')
  })

  it('returns empty array when no correlations found', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/templates/019abc-1/correlations')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
  })

  it('accepts hours and limit params', async () => {
    const app = createTestApp(correlationQueryMap())

    const res = await request(app)
      .get('/v1/templates/019abc-1/correlations?hours=72&limit=5')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 72)
    assert.equal(res.body.meta.limit, 5)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp()
    const res = await request(app).get('/v1/templates/019abc-1/correlations')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/services/:name/outlier
// ---------------------------------------------------------------------------

describe('GET /v1/services/:name/outlier', () => {
  function outlierQueryMap(row = mockOutlierRow): Map<string, unknown> {
    const map = new Map<string, unknown>()
    map.set('stddevPopIf', [row])
    return map
  }

  it('returns outlier verdict with z-score', async () => {
    const app = createTestApp(outlierQueryMap())

    const res = await request(app)
      .get('/v1/services/payment-service/outlier')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    const d = res.body.data
    assert.equal(d.service, 'payment-service')
    assert.equal(d.currentRate, 12)
    assert.equal(d.baselineMean, 5.2)
    assert.equal(d.baselineStddev, 1.8)
    // z = (12 - 5.2) / 1.8 = 3.78
    assert.ok(d.zScore > 3.5, `z-score should be > 3.5, got ${d.zScore}`)
    assert.equal(d.verdict, 'outlier')
    assert.equal(d.dataPoints, 168)
    assert.equal(d.warning, undefined)
  })

  it('returns elevated verdict when z between 1.5 and 2', async () => {
    const app = createTestApp(outlierQueryMap({
      ...mockOutlierRow,
      current_rate: '8.0',
    }))

    const res = await request(app)
      .get('/v1/services/api-gateway/outlier')
      .set('Authorization', `Bearer ${KEY_A}`)

    // z = (8 - 5.2) / 1.8 = 1.56
    assert.equal(res.body.data.verdict, 'elevated')
  })

  it('returns normal verdict when z below 1.5', async () => {
    const app = createTestApp(outlierQueryMap({
      ...mockOutlierRow,
      current_rate: '5.5',
    }))

    const res = await request(app)
      .get('/v1/services/api-gateway/outlier')
      .set('Authorization', `Bearer ${KEY_A}`)

    // z = (5.5 - 5.2) / 1.8 = 0.17
    assert.equal(res.body.data.verdict, 'normal')
  })

  it('adds warning when insufficient data points', async () => {
    const app = createTestApp(outlierQueryMap({
      ...mockOutlierRow,
      data_points: '48',
    }))

    const res = await request(app)
      .get('/v1/services/payment-service/outlier')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.body.data.dataPoints, 48)
    assert.ok(res.body.data.warning)
    assert.ok(res.body.data.warning.includes('48'))
    assert.ok(res.body.data.warning.includes('168'))
  })

  it('handles zero stddev gracefully', async () => {
    const app = createTestApp(outlierQueryMap({
      ...mockOutlierRow,
      baseline_stddev: '0',
    }))

    const res = await request(app)
      .get('/v1/services/payment-service/outlier')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.body.data.zScore, 0)
    assert.equal(res.body.data.verdict, 'normal')
  })

  it('handles no data (empty query result)', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/services/unknown-service/outlier')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.verdict, 'insufficient_data')
    assert.equal(res.body.data.currentRate, 0)
    assert.equal(res.body.data.dataPoints, 0)
    assert.ok(res.body.data.warning)
  })

  it('accepts hours param', async () => {
    const app = createTestApp(outlierQueryMap())

    const res = await request(app)
      .get('/v1/services/payment-service/outlier?hours=6')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 6)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp()
    const res = await request(app).get('/v1/services/payment-service/outlier')
    assert.equal(res.status, 401)
  })
})
