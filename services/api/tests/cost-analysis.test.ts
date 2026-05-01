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
import { costRoutes } from '../src/routes/cost.js'
import { TenantSettingsStore } from '../src/watches/tenant-settings.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_A = 'key-a'
const KEY_B = 'key-b'
const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const keyMap = new Map([
  [KEY_A, TENANT_A],
  [KEY_B, TENANT_B],
])

// ---------------------------------------------------------------------------
// Mock data — ClickHouse returns numbers as strings
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<{
  template_id: string
  template_text: string
  service: string
  level: string
  count: string
  service_total: string
}>) {
  return {
    template_id: overrides.template_id ?? 'tmpl-1',
    template_text: overrides.template_text ?? 'Health check responded in <*> ms',
    service: overrides.service ?? 'api-gateway',
    level: overrides.level ?? 'DEBUG',
    count: overrides.count ?? '500',
    service_total: overrides.service_total ?? '1000',
  }
}

// ---------------------------------------------------------------------------
// Mock DbClient
// ---------------------------------------------------------------------------

function createMockDb(queryResults?: unknown[]): DbClient {
  return {
    query: async () => queryResults ?? [],
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

function createTestApp(opts?: { queryResults?: unknown[]; settingsStore?: TenantSettingsStore }) {
  const logger = pino({ level: 'silent' })
  const db = createMockDb(opts?.queryResults)
  const settingsStore = opts?.settingsStore ?? new TenantSettingsStore({ logger })
  const app = express()
  app.use(express.json())
  const v1 = Router()
  v1.use(createAuthMiddleware(new Map(keyMap)))
  v1.use(createRateLimiter({ keyRpm: 1000, tenantRpm: 2000, ingestKeyRpm: 3000 }))
  v1.use(createConcurrentQueryGuard({ maxConcurrent: 100 }))
  v1.use(costRoutes({ db, logger, settingsStore }))
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return { app, settingsStore }
}

// ---------------------------------------------------------------------------
// GET /v1/cost/analysis
// ---------------------------------------------------------------------------

describe('GET /v1/cost/analysis', () => {
  it('returns 200 with empty patterns when no data', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.patterns, [])
    assert.equal(res.body.data.summary.totalPatternsAnalyzed, 0)
    assert.equal(res.body.data.summary.noiseCount, 0)
    assert.equal(res.body.data.summary.reviewCount, 0)
    assert.equal(res.body.data.summary.keepCount, 0)
    assert.equal(res.body.data.summary.potentialReductionPct, 0)
  })

  it('classifies DEBUG template above threshold as noise', async () => {
    const rows = [
      makeRow({ level: 'DEBUG', count: '600', service_total: '1000' }), // 60% → noise
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.patterns.length, 1)
    assert.equal(res.body.data.patterns[0].classification, 'noise')
    assert.ok(res.body.data.patterns[0].suggestion.includes('Consider removing'))
    assert.equal(res.body.data.patterns[0].volumePct, 60)
    assert.equal(res.body.data.summary.noiseCount, 1)
  })

  it('classifies TRACE template above threshold as noise', async () => {
    const rows = [
      makeRow({ level: 'TRACE', count: '100', service_total: '1000' }), // 10% → noise (>5%)
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.patterns[0].classification, 'noise')
  })

  it('classifies INFO template above threshold as review', async () => {
    const rows = [
      makeRow({ level: 'INFO', count: '200', service_total: '1000' }), // 20% → review (>10%)
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.patterns[0].classification, 'review')
    assert.ok(res.body.data.patterns[0].suggestion.includes('Consider sampling'))
    assert.equal(res.body.data.summary.reviewCount, 1)
  })

  it('classifies WARN template above threshold as review', async () => {
    const rows = [
      makeRow({ level: 'WARN', count: '250', service_total: '1000' }), // 25% → review (>20%)
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.patterns[0].classification, 'review')
    assert.ok(res.body.data.patterns[0].suggestion.includes('warnings'))
  })

  it('excludes keep patterns (ERROR level)', async () => {
    const rows = [
      makeRow({ level: 'ERROR', count: '500', service_total: '1000' }), // ERROR → always keep
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.patterns, [])
    assert.equal(res.body.data.summary.keepCount, 1)
    assert.equal(res.body.data.summary.totalPatternsAnalyzed, 1)
  })

  it('excludes keep patterns (below threshold)', async () => {
    const rows = [
      makeRow({ level: 'DEBUG', count: '10', service_total: '1000' }), // 1% < 5% → keep
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.patterns, [])
    assert.equal(res.body.data.summary.keepCount, 1)
  })

  it('sorts noise before review, each by volumePct descending', async () => {
    const rows = [
      makeRow({ template_id: 't1', level: 'INFO', count: '200', service_total: '1000' }),  // review 20%
      makeRow({ template_id: 't2', level: 'DEBUG', count: '100', service_total: '1000' }),  // noise 10%
      makeRow({ template_id: 't3', level: 'DEBUG', count: '300', service_total: '1000' }),  // noise 30%
      makeRow({ template_id: 't4', level: 'INFO', count: '150', service_total: '1000' }),   // review 15%
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.patterns.length, 4)
    // Noise first, sorted by volumePct desc
    assert.equal(res.body.data.patterns[0].templateId, 't3') // noise 30%
    assert.equal(res.body.data.patterns[1].templateId, 't2') // noise 10%
    // Then review, sorted by volumePct desc
    assert.equal(res.body.data.patterns[2].templateId, 't1') // review 20%
    assert.equal(res.body.data.patterns[3].templateId, 't4') // review 15%
  })

  it('respects custom tenant thresholds', async () => {
    const rows = [
      makeRow({ level: 'DEBUG', count: '80', service_total: '1000' }), // 8% — noise with default 5%, keep with custom 10%
    ]
    const settingsStore = new TenantSettingsStore()
    await settingsStore.set(TENANT_A, { costNoiseDebugPct: 10 })
    const { app } = createTestApp({ queryResults: rows, settingsStore })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    // 8% < custom threshold 10%, so it should be keep (excluded)
    assert.deepEqual(res.body.data.patterns, [])
    assert.equal(res.body.data.summary.keepCount, 1)
    assert.equal(res.body.data.thresholds.noiseDebugPct, 10)
  })

  it('returns thresholds in response', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.thresholds.noiseDebugPct, 5)
    assert.equal(res.body.data.thresholds.reviewInfoPct, 10)
    assert.equal(res.body.data.thresholds.reviewWarnPct, 20)
  })

  it('accepts hours query parameter', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis?hours=48')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 48)
  })

  it('accepts service filter', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis?service=api-gateway')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
  })

  it('rejects invalid hours (> 720)', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis?hours=1000')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 400)
  })

  it('rejects invalid hours (< 1)', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis?hours=0')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 400)
  })

  it('handles division by zero gracefully (service_total = 0)', async () => {
    const rows = [
      makeRow({ level: 'DEBUG', count: '0', service_total: '0' }),
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    // volumePct = 0, below any threshold → keep
    assert.equal(res.body.data.summary.keepCount, 1)
  })

  it('computes potentialReductionPct from noise + review volumes', async () => {
    const rows = [
      makeRow({ template_id: 't1', level: 'DEBUG', count: '300', service_total: '1000' }), // noise 30%
      makeRow({ template_id: 't2', level: 'INFO', count: '200', service_total: '1000' }),   // review 20%
      makeRow({ template_id: 't3', level: 'ERROR', count: '500', service_total: '1000' }),   // keep
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.summary.potentialReductionPct, 50)
  })

  it('computes potentialReductionPct correctly across multiple services', async () => {
    // svc-a: 300 noise out of 1000 total (30%)
    // svc-b: 600 review out of 2000 total (30% > 10% INFO threshold)
    // potentialReductionPct = (300 + 600) / (1000 + 2000) = 900/3000 = 30%
    // Old (buggy) code would sum per-service percentages: 30 + 30 = 60 — wrong
    const rows = [
      makeRow({ template_id: 't1', service: 'svc-a', level: 'DEBUG', count: '300', service_total: '1000' }),
      makeRow({ template_id: 't2', service: 'svc-a', level: 'ERROR', count: '700', service_total: '1000' }),
      makeRow({ template_id: 't3', service: 'svc-b', level: 'INFO', count: '600', service_total: '2000' }),
      makeRow({ template_id: 't4', service: 'svc-b', level: 'ERROR', count: '1400', service_total: '2000' }),
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.summary.potentialReductionPct, 30)
  })

  it('accepts level filter as comma-separated query param', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis?level=ERROR,WARN')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
  })

  it('filters rows when level param is set — patterns from those rows are classified normally', async () => {
    const rows = [
      makeRow({ level: 'DEBUG', count: '600', service_total: '1000' }),
    ]
    const { app } = createTestApp({ queryResults: rows })

    const res = await request(app)
      .get('/v1/cost/analysis?level=DEBUG')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.patterns.length, 1)
    assert.equal(res.body.data.patterns[0].level, 'DEBUG')
    assert.equal(res.body.data.patterns[0].classification, 'noise')
  })

  it('accepts single level filter', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis?level=ERROR')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
  })

  it('requires authentication', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app).get('/v1/cost/analysis')

    assert.equal(res.status, 401)
  })

  it('returns meta with fetchedAt and timeRange', async () => {
    const { app } = createTestApp({ queryResults: [] })

    const res = await request(app)
      .get('/v1/cost/analysis')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.ok(res.body.meta.fetchedAt)
    assert.ok(res.body.meta.timeRange)
  })
})
