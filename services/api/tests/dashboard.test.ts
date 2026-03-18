import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../src/db/client.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { dashboardRoutes } from '../src/routes/dashboard.js'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_KEY = 'test-api-key'
const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const keyMap = new Map([
  [TEST_KEY, TENANT_A],
  ['test-key-b', TENANT_B],
])

// ---------------------------------------------------------------------------
// Mock data — ClickHouse returns numbers as strings in JSONEachRow
// ---------------------------------------------------------------------------

const mockTemplateStatsRows = [
  {
    template_id: 'tmpl-1',
    template_text: 'Error in {service}',
    service: 'api',
    occurrence_count: '100',
    error_count: '5',
    avg_duration_ms: '12.5',
    max_anomaly_score: '0.8',
  },
  {
    template_id: 'tmpl-2',
    template_text: 'Request to {path}',
    service: 'web',
    occurrence_count: '50',
    error_count: '0',
    avg_duration_ms: '8.2',
    max_anomaly_score: '0.1',
  },
]

const mockNewTodayRows = [{ template_id: 'tmpl-1' }]

const mockServiceStatsRows = [
  {
    service: 'api',
    log_count: '1000',
    error_count: '50',
    warn_count: '100',
    new_template_count: '3',
    avg_anomaly_score: '0.3',
  },
  {
    service: 'web',
    log_count: '500',
    error_count: '10',
    warn_count: '25',
    new_template_count: '1',
    avg_anomaly_score: '0.1',
  },
]

const mockVolumeRows = [
  {
    interval_start: '2026-03-17T00:00:00.000Z',
    service: 'api',
    log_count: '200',
    error_count: '10',
  },
  {
    interval_start: '2026-03-17T01:00:00.000Z',
    service: 'api',
    log_count: '180',
    error_count: '8',
  },
]

const mockOverviewAggregatesRow = {
  total_events: '5000',
  error_count: '200',
  warn_count: '500',
  new_template_count: '10',
}

const mockOverviewCountsRow = {
  unique_templates: '42',
  unclustered_count: '15',
  service_count: '5',
}

const mockSparklineRows = [
  {
    template_id: 'tmpl-1',
    interval_start: '2026-03-17T00:00:00.000Z',
    count: '30',
  },
  {
    template_id: 'tmpl-1',
    interval_start: '2026-03-17T01:00:00.000Z',
    count: '25',
  },
  {
    template_id: 'tmpl-2',
    interval_start: '2026-03-17T00:00:00.000Z',
    count: '10',
  },
]

const mockClusteringHealthSnapshotRow = {
  total_events: '1000',
  clustered_events: '950',
  unclustered_events: '50',
  unique_templates: '30',
}

const mockClusteringHealthTrendRows = [
  {
    interval_start: '2026-03-17T00:00:00.000Z',
    total: '500',
    unclustered: '20',
  },
  {
    interval_start: '2026-03-17T01:00:00.000Z',
    total: '500',
    unclustered: '30',
  },
]

// ---------------------------------------------------------------------------
// Mock DbClient factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock DbClient that routes queries based on SQL substring matching.
 * The queryResults map maps SQL substrings to the mock data that should be returned.
 * For single-row queries (overview aggregates, overview counts, clustering snapshot),
 * the mock returns the row directly (as a single-element array) since the route
 * handler accesses rows[0].
 */
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

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: build a query results map for the templates endpoint
// ---------------------------------------------------------------------------

function templatesQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  // Template stats query: groups by template_id, template_text, service
  map.set('GROUP BY template_id', mockTemplateStatsRows)
  // New today IDs query: uses is_new_template
  map.set('is_new_template', mockNewTodayRows)
  return map
}

function servicesQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('GROUP BY service', mockServiceStatsRows)
  return map
}

function volumeQueryMap(includePrevious = false): Map<string, unknown> {
  const map = new Map<string, unknown>()
  // Volume queries go to service_stats with GROUP BY interval_start
  // Both current and previous hit the same mock, so we return the
  // same or different data depending on what's requested
  if (includePrevious) {
    // When offset is provided, both queries match the same SQL pattern.
    // We return the current rows for both (test verifies the shape, not the data
    // selection logic which belongs to the DB layer).
    map.set('GROUP BY interval_start', mockVolumeRows)
  } else {
    map.set('GROUP BY interval_start', mockVolumeRows)
  }
  return map
}

function overviewQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  // Aggregates from service_stats (no GROUP BY, no uniq)
  map.set('new_template_count', [mockOverviewAggregatesRow])
  // Counts from log_metadata with uniq(service)
  map.set('uniq(service)', [mockOverviewCountsRow])
  return map
}

function sparklineQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('template_id IN', mockSparklineRows)
  return map
}

function clusteringHealthQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  // Snapshot: from log_metadata with clustered_events
  map.set('clustered_events', [mockClusteringHealthSnapshotRow])
  // Trend: from log_metadata with toStartOfHour
  map.set('toStartOfHour', mockClusteringHealthTrendRows)
  return map
}

// ---------------------------------------------------------------------------
// Tests: Templates endpoint
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/templates', () => {
  it('returns correct shape with data + meta envelope', async () => {
    const app = createTestApp(templatesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/templates')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data), 'data should be an array')
    assert.equal(res.body.data.length, 2)
    assert.ok(res.body.meta, 'meta should be present')
    assert.equal(typeof res.body.meta.hours, 'number')
    assert.equal(typeof res.body.meta.count, 'number')
    assert.equal(typeof res.body.meta.fetchedAt, 'string')
    assert.equal(res.body.meta.count, 2)
  })

  it('returns 401 without auth header', async () => {
    const app = createTestApp(templatesQueryMap())

    const res = await request(app).get('/v1/dashboard/templates')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('returns 400 for invalid hours (hours=0)', async () => {
    const app = createTestApp(templatesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/templates?hours=0')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('empty results return { data: [], meta: { count: 0 } }', async () => {
    // No query results configured -- everything returns []
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/dashboard/templates')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
    assert.equal(res.body.meta.count, 0)
  })

  it('isNewToday flag is set correctly when template ID appears in newTodayIds query', async () => {
    const app = createTestApp(templatesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/templates')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const tmpl1 = res.body.data.find((r: { templateId: string }) => r.templateId === 'tmpl-1')
    const tmpl2 = res.body.data.find((r: { templateId: string }) => r.templateId === 'tmpl-2')
    assert.ok(tmpl1, 'tmpl-1 should be in results')
    assert.ok(tmpl2, 'tmpl-2 should be in results')
    assert.equal(tmpl1.isNewToday, true, 'tmpl-1 should be marked as new today')
    assert.equal(tmpl2.isNewToday, false, 'tmpl-2 should not be marked as new today')
  })

  it('coerces ClickHouse string numbers to actual numbers', async () => {
    const app = createTestApp(templatesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/templates')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const row = res.body.data[0]
    assert.equal(typeof row.occurrenceCount, 'number')
    assert.equal(row.occurrenceCount, 100)
    assert.equal(typeof row.errorCount, 'number')
    assert.equal(row.errorCount, 5)
    assert.equal(typeof row.avgDurationMs, 'number')
    assert.equal(row.avgDurationMs, 12.5)
    assert.equal(typeof row.maxAnomalyScore, 'number')
    assert.equal(row.maxAnomalyScore, 0.8)
  })

  it('returns 400 for hours exceeding maximum (hours=999)', async () => {
    const app = createTestApp(templatesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/templates?hours=999')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('accepts a service filter parameter', async () => {
    const app = createTestApp(templatesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/templates?service=api')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data))
  })

  it('uses defaults when hours and limit are not provided', async () => {
    const app = createTestApp(templatesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/templates')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    // Default hours is 24 per the schema
    assert.equal(res.body.meta.hours, 24)
  })
})

// ---------------------------------------------------------------------------
// Tests: Services endpoint
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/services', () => {
  it('returns service rows with computed errorRate and warnRate', async () => {
    const app = createTestApp(servicesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/services')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data))
    assert.equal(res.body.data.length, 2)

    const apiRow = res.body.data.find((r: { service: string }) => r.service === 'api')
    assert.ok(apiRow, 'api service should be in results')
    assert.equal(apiRow.logCount, 1000)
    assert.equal(apiRow.errorCount, 50)
    assert.equal(apiRow.warnCount, 100)
    // errorRate = (50/1000) * 100 = 5.0
    assert.equal(apiRow.errorRate, 5.0)
    // warnRate = (100/1000) * 100 = 10.0
    assert.equal(apiRow.warnRate, 10.0)
    assert.equal(apiRow.newTemplateCount, 3)
    assert.equal(apiRow.avgAnomalyScore, 0.3)
  })

  it('defaults to hours=24 and limit=100 when not specified', async () => {
    const app = createTestApp(servicesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/services')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 24)
    assert.equal(res.body.meta.limit, 100)
  })

  it('computes errorRate and warnRate as 0 when logCount is 0', async () => {
    const zeroCountMap = new Map<string, unknown>()
    zeroCountMap.set('GROUP BY service', [
      {
        service: 'empty',
        log_count: '0',
        error_count: '0',
        warn_count: '0',
        new_template_count: '0',
        avg_anomaly_score: '0',
      },
    ])
    const app = createTestApp(zeroCountMap)

    const res = await request(app)
      .get('/v1/dashboard/services')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const row = res.body.data[0]
    assert.equal(row.errorRate, 0)
    assert.equal(row.warnRate, 0)
  })

  it('returns 401 without auth header', async () => {
    const app = createTestApp(servicesQueryMap())

    const res = await request(app).get('/v1/dashboard/services')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })
})

// ---------------------------------------------------------------------------
// Tests: Volume endpoint
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/volume', () => {
  it('returns volume data shape with current array', async () => {
    const app = createTestApp(volumeQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/volume')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data.current), 'current should be an array')
    assert.equal(res.body.data.current.length, 2)
    assert.equal(res.body.data.previous, undefined, 'previous should not be present without offset')

    const point = res.body.data.current[0]
    assert.equal(typeof point.intervalStart, 'string')
    assert.equal(typeof point.service, 'string')
    assert.equal(typeof point.logCount, 'number')
    assert.equal(typeof point.errorCount, 'number')
  })

  it('with offset=24, returns both current and previous arrays', async () => {
    const app = createTestApp(volumeQueryMap(true))

    const res = await request(app)
      .get('/v1/dashboard/volume?offset=24')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data.current), 'current should be an array')
    assert.ok(Array.isArray(res.body.data.previous), 'previous should be an array when offset > 0')
  })

  it('returns 401 without auth header', async () => {
    const app = createTestApp(volumeQueryMap())

    const res = await request(app).get('/v1/dashboard/volume')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('returns empty current array when no data exists', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/dashboard/volume')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.current, [])
    assert.equal(res.body.meta.count, 0)
  })
})

// ---------------------------------------------------------------------------
// Tests: Overview endpoint
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/overview', () => {
  it('returns overview data shape with all fields', async () => {
    const app = createTestApp(overviewQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/overview')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const data = res.body.data
    assert.equal(typeof data.totalEvents, 'number')
    assert.equal(data.totalEvents, 5000)
    assert.equal(typeof data.totalTemplates, 'number')
    assert.equal(data.totalTemplates, 42)
    assert.equal(typeof data.newTemplatesToday, 'number')
    assert.equal(data.newTemplatesToday, 10)
    assert.equal(typeof data.unclusteredCount, 'number')
    assert.equal(data.unclusteredCount, 15)
    assert.equal(typeof data.errorRate, 'number')
    // errorRate = (200/5000) * 100 = 4.0
    assert.equal(data.errorRate, 4.0)
    assert.equal(typeof data.serviceCount, 'number')
    assert.equal(data.serviceCount, 5)
  })

  it('returns meta with count=1 and hours', async () => {
    const app = createTestApp(overviewQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/overview?hours=12')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.count, 1)
    assert.equal(res.body.meta.hours, 12)
  })

  it('returns 401 without auth header', async () => {
    const app = createTestApp(overviewQueryMap())

    const res = await request(app).get('/v1/dashboard/overview')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('computes errorRate as 0 when totalEvents is 0', async () => {
    const zeroMap = new Map<string, unknown>()
    zeroMap.set('new_template_count', [
      { total_events: '0', error_count: '0', warn_count: '0', new_template_count: '0' },
    ])
    zeroMap.set('uniq(service)', [
      { unique_templates: '0', unclustered_count: '0', service_count: '0' },
    ])
    const app = createTestApp(zeroMap)

    const res = await request(app)
      .get('/v1/dashboard/overview')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.errorRate, 0)
    assert.equal(res.body.data.totalEvents, 0)
  })
})

// ---------------------------------------------------------------------------
// Tests: Sparklines endpoint
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/template-sparklines', () => {
  it('returns 400 when template_ids is missing', async () => {
    const app = createTestApp(sparklineQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/template-sparklines')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('returns 400 when more than 20 template IDs provided', async () => {
    const app = createTestApp(sparklineQueryMap())
    const ids = Array.from({ length: 21 }, (_, i) => `tmpl-${i}`).join(',')

    const res = await request(app)
      .get(`/v1/dashboard/template-sparklines?template_ids=${ids}`)
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('returns correctly shaped sparkline data', async () => {
    const app = createTestApp(sparklineQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/template-sparklines?template_ids=tmpl-1,tmpl-2')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const data = res.body.data
    assert.ok(data['tmpl-1'], 'tmpl-1 sparkline data should be present')
    assert.ok(data['tmpl-2'], 'tmpl-2 sparkline data should be present')
    assert.equal(data['tmpl-1'].length, 2)
    assert.equal(data['tmpl-2'].length, 1)

    const point = data['tmpl-1'][0]
    assert.equal(typeof point.intervalStart, 'string')
    assert.equal(typeof point.count, 'number')
    assert.equal(point.count, 30)
  })

  it('returns 401 without auth header', async () => {
    const app = createTestApp(sparklineQueryMap())

    const res = await request(app).get('/v1/dashboard/template-sparklines?template_ids=tmpl-1')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('returns 400 when template_ids is empty string', async () => {
    const app = createTestApp(sparklineQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/template-sparklines?template_ids=')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('accepts exactly 20 template IDs', async () => {
    const app = createTestApp(sparklineQueryMap())
    const ids = Array.from({ length: 20 }, (_, i) => `tmpl-${i}`).join(',')

    const res = await request(app)
      .get(`/v1/dashboard/template-sparklines?template_ids=${ids}`)
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
  })

  it('meta.count matches number of unique template IDs in response', async () => {
    const app = createTestApp(sparklineQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/template-sparklines?template_ids=tmpl-1,tmpl-2')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.count, 2)
  })
})

// ---------------------------------------------------------------------------
// Tests: Clustering Health endpoint
// ---------------------------------------------------------------------------

describe('GET /v1/dashboard/clustering-health', () => {
  it('returns clustering health data with snapshot + trend', async () => {
    const app = createTestApp(clusteringHealthQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/clustering-health')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const data = res.body.data

    // Snapshot fields
    assert.equal(typeof data.totalEvents, 'number')
    assert.equal(data.totalEvents, 1000)
    assert.equal(typeof data.clusteredEvents, 'number')
    assert.equal(data.clusteredEvents, 950)
    assert.equal(typeof data.unclusteredEvents, 'number')
    assert.equal(data.unclusteredEvents, 50)
    assert.equal(typeof data.uniqueTemplates, 'number')
    assert.equal(data.uniqueTemplates, 30)
    assert.equal(typeof data.compressionRatio, 'number')
    // compressionRatio = 30 / 1000 = 0.03
    assert.equal(data.compressionRatio, 0.03)

    // Trend fields
    assert.ok(Array.isArray(data.trend), 'trend should be an array')
    assert.equal(data.trend.length, 2)

    const trendPoint = data.trend[0]
    assert.equal(typeof trendPoint.intervalStart, 'string')
    assert.equal(typeof trendPoint.total, 'number')
    assert.equal(trendPoint.total, 500)
    assert.equal(typeof trendPoint.unclustered, 'number')
    assert.equal(trendPoint.unclustered, 20)
    assert.equal(typeof trendPoint.ratio, 'number')
    // ratio = 20 / 500 = 0.04
    assert.equal(trendPoint.ratio, 0.04)
  })

  it('returns 401 without auth header', async () => {
    const app = createTestApp(clusteringHealthQueryMap())

    const res = await request(app).get('/v1/dashboard/clustering-health')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('compressionRatio is 0 when totalEvents is 0', async () => {
    const zeroMap = new Map<string, unknown>()
    zeroMap.set('clustered_events', [
      {
        total_events: '0',
        clustered_events: '0',
        unclustered_events: '0',
        unique_templates: '0',
      },
    ])
    zeroMap.set('toStartOfHour', [])
    const app = createTestApp(zeroMap)

    const res = await request(app)
      .get('/v1/dashboard/clustering-health')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.compressionRatio, 0)
    assert.equal(res.body.data.totalEvents, 0)
  })

  it('trend point ratio is 0 when total is 0', async () => {
    const zeroTrendMap = new Map<string, unknown>()
    zeroTrendMap.set('clustered_events', [mockClusteringHealthSnapshotRow])
    zeroTrendMap.set('toStartOfHour', [
      { interval_start: '2026-03-17T00:00:00.000Z', total: '0', unclustered: '0' },
    ])
    const app = createTestApp(zeroTrendMap)

    const res = await request(app)
      .get('/v1/dashboard/clustering-health')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.trend[0].ratio, 0)
  })

  it('meta.count matches trend array length', async () => {
    const app = createTestApp(clusteringHealthQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/clustering-health')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.count, 2)
  })
})

// ---------------------------------------------------------------------------
// Tests: Changes endpoint
// ---------------------------------------------------------------------------

const mockNewTemplateRows = [
  {
    template_id: 'tmpl-new-1',
    template_text: 'Connection timeout in {service}',
    service: 'api',
    occurrence_count: '42',
    error_count: '10',
    first_seen: '2026-03-17T14:30:00.000Z',
  },
]

const mockSpikeRows = [
  {
    template_id: 'tmpl-spike-1',
    template_text: 'Rate limit exceeded for {user}',
    service: 'web',
    current_count: '300',
    previous_count: '50',
    spike_ratio: '6.0',
  },
]

const mockResolvedRows = [
  {
    template_id: 'tmpl-resolved-1',
    template_text: 'Disk space warning on {host}',
    service: 'infra',
    last_seen: '2026-03-16T10:00:00.000Z',
    prev_count: '25',
  },
]

function changesQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  // New templates query: uses is_new_template
  map.set('is_new_template', mockNewTemplateRows)
  // Spikes query: uses spike_ratio
  map.set('spike_ratio', mockSpikeRows)
  // Resolved query: uses previous_active
  map.set('previous_active', mockResolvedRows)
  return map
}

describe('GET /v1/dashboard/changes', () => {
  it('returns correct shape with all three change types', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data), 'data should be an array')
    assert.equal(res.body.data.length, 3)
    assert.ok(res.body.meta, 'meta should be present')
    assert.equal(typeof res.body.meta.hours, 'number')
    assert.equal(typeof res.body.meta.count, 'number')
    assert.equal(res.body.meta.count, 3)
    assert.equal(typeof res.body.meta.fetchedAt, 'string')
  })

  it('maps new template events correctly', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const newEvent = res.body.data.find((e: { type: string }) => e.type === 'new')
    assert.ok(newEvent, 'should have a new event')
    assert.equal(newEvent.templateId, 'tmpl-new-1')
    assert.equal(newEvent.templateText, 'Connection timeout in {service}')
    assert.equal(newEvent.service, 'api')
    assert.equal(newEvent.currentCount, 42)
    assert.equal(newEvent.previousCount, 0)
    assert.equal(newEvent.ratio, 999)
    assert.equal(newEvent.firstSeen, '2026-03-17T14:30:00.000Z')
  })

  it('maps spike events correctly with numeric coercion', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const spikeEvent = res.body.data.find((e: { type: string }) => e.type === 'spike')
    assert.ok(spikeEvent, 'should have a spike event')
    assert.equal(spikeEvent.templateId, 'tmpl-spike-1')
    assert.equal(typeof spikeEvent.currentCount, 'number')
    assert.equal(spikeEvent.currentCount, 300)
    assert.equal(typeof spikeEvent.previousCount, 'number')
    assert.equal(spikeEvent.previousCount, 50)
    assert.equal(typeof spikeEvent.ratio, 'number')
    assert.equal(spikeEvent.ratio, 6.0)
  })

  it('maps resolved events correctly', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const resolvedEvent = res.body.data.find((e: { type: string }) => e.type === 'resolved')
    assert.ok(resolvedEvent, 'should have a resolved event')
    assert.equal(resolvedEvent.templateId, 'tmpl-resolved-1')
    assert.equal(resolvedEvent.currentCount, 0)
    assert.equal(resolvedEvent.previousCount, 25)
    assert.equal(resolvedEvent.ratio, 0)
    assert.equal(resolvedEvent.lastSeen, '2026-03-16T10:00:00.000Z')
  })

  it('sorts events by ratio descending (spikes first)', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    const ratios = res.body.data.map((e: { ratio: number }) => e.ratio)
    // Expected: [999 (new), 6.0 (spike), 0 (resolved)]
    for (let i = 1; i < ratios.length; i++) {
      assert.ok(ratios[i - 1] >= ratios[i], `ratios should be descending: ${ratios}`)
    }
  })

  it('returns 401 without auth header', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app).get('/v1/dashboard/changes')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('returns 400 for invalid hours (hours=0)', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes?hours=0')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('returns 400 for limit exceeding max (limit=200)', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes?limit=200')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('accepts service filter parameter', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes?service=api')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data))
  })

  it('uses defaults: hours=24, limit=20, threshold=3', async () => {
    const app = createTestApp(changesQueryMap())

    const res = await request(app)
      .get('/v1/dashboard/changes')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 24)
    assert.equal(res.body.meta.limit, 20)
  })

  it('returns empty array when no changes exist', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/dashboard/changes')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
    assert.equal(res.body.meta.count, 0)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: all endpoints return 401 without auth
// ---------------------------------------------------------------------------

describe('cross-cutting: auth enforcement', () => {
  const endpoints = [
    '/v1/dashboard/templates',
    '/v1/dashboard/services',
    '/v1/dashboard/volume',
    '/v1/dashboard/overview',
    '/v1/dashboard/template-sparklines?template_ids=tmpl-1',
    '/v1/dashboard/clustering-health',
    '/v1/dashboard/changes',
  ]

  for (const endpoint of endpoints) {
    it(`${endpoint} returns 401 without Authorization header`, async () => {
      const app = createTestApp()

      const res = await request(app).get(endpoint)

      assert.equal(res.status, 401)
      assert.equal(res.body.error.code, 'UNAUTHORIZED')
    })
  }

  for (const endpoint of endpoints) {
    it(`${endpoint} returns 401 with invalid API key`, async () => {
      const app = createTestApp()

      const res = await request(app)
        .get(endpoint)
        .set('Authorization', 'Bearer invalid-key-that-does-not-exist')

      assert.equal(res.status, 401)
      assert.equal(res.body.error.code, 'UNAUTHORIZED')
    })
  }
})

// ---------------------------------------------------------------------------
// Cross-cutting: response envelope structure
// ---------------------------------------------------------------------------

describe('cross-cutting: response envelope', () => {
  it('all endpoints include fetchedAt ISO string in meta', async () => {
    const allMocks = new Map<string, unknown>([
      ...templatesQueryMap(),
      ...servicesQueryMap(),
      ...overviewQueryMap(),
      ...clusteringHealthQueryMap(),
    ])
    // Add volume mock
    allMocks.set('GROUP BY interval_start', mockVolumeRows)

    const app = createTestApp(allMocks)

    const endpoints = [
      '/v1/dashboard/templates',
      '/v1/dashboard/services',
      '/v1/dashboard/volume',
      '/v1/dashboard/overview',
      '/v1/dashboard/clustering-health',
      '/v1/dashboard/changes',
    ]

    for (const endpoint of endpoints) {
      const res = await request(app).get(endpoint).set('Authorization', `Bearer ${TEST_KEY}`)

      assert.equal(res.status, 200, `${endpoint} should return 200`)
      assert.ok(res.body.meta.fetchedAt, `${endpoint} should have fetchedAt in meta`)
      // fetchedAt should be a valid ISO date
      const parsed = Date.parse(res.body.meta.fetchedAt)
      assert.ok(!Number.isNaN(parsed), `${endpoint} fetchedAt should be a valid ISO date`)
    }
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: tenant isolation
// ---------------------------------------------------------------------------

describe('cross-cutting: tenant isolation', () => {
  it('different API keys resolve to different tenants (queries use correct tenant_id)', async () => {
    const capturedTenantIds: string[] = []
    const db = {
      query: async (params: { query: string; query_params: Record<string, unknown> }) => {
        if (params.query_params.tenant_id) {
          capturedTenantIds.push(params.query_params.tenant_id as string)
        }
        return []
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient

    const logger = pino({ level: 'silent' })
    const app = express()
    app.use(express.json())
    const auth = createAuthMiddleware(keyMap)
    app.use('/v1', auth, dashboardRoutes({ db, logger }))
    app.use(createErrorHandler(logger))

    // Request with tenant A
    await request(app).get('/v1/dashboard/templates').set('Authorization', `Bearer ${TEST_KEY}`)

    const tenantAIds = [...capturedTenantIds]
    assert.ok(tenantAIds.length > 0, 'should have captured tenant IDs for tenant A')
    assert.ok(
      tenantAIds.every((id) => id === TENANT_A),
      `all queries should use tenant_id=${TENANT_A}`,
    )

    // Clear and request with tenant B
    capturedTenantIds.length = 0
    await request(app).get('/v1/dashboard/templates').set('Authorization', 'Bearer test-key-b')

    assert.ok(capturedTenantIds.length > 0, 'should have captured tenant IDs for tenant B')
    assert.ok(
      capturedTenantIds.every((id) => id === TENANT_B),
      `all queries should use tenant_id=${TENANT_B}`,
    )
  })
})

// ---------------------------------------------------------------------------
// Edge case: DB error produces 500 with safe error message
// ---------------------------------------------------------------------------

describe('cross-cutting: error handling', () => {
  it('returns 500 with safe error when DB query fails', async () => {
    const failingDb = {
      query: async () => {
        throw new Error('Connection refused: clickhouse:8123')
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient

    const logger = pino({ level: 'silent' })
    const app = express()
    app.use(express.json())
    const auth = createAuthMiddleware(keyMap)
    app.use('/v1', auth, dashboardRoutes({ db: failingDb, logger }))
    app.use(createErrorHandler(logger))

    const res = await request(app)
      .get('/v1/dashboard/templates')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 500)
    assert.equal(res.body.error.code, 'INTERNAL_ERROR')
    assert.equal(res.body.error.message, 'Internal server error')
    // Must not leak internal connection details
    assert.ok(
      !JSON.stringify(res.body).includes('Connection refused'),
      'Error response must not leak internal details',
    )
  })
})
