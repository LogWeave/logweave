import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { settingsRoutes } from '../src/routes/settings.js'
import { TenantSettingsStore } from '../src/watches/tenant-settings.js'

const TEST_KEY = 'test-key'
const TENANT_A = 'tenant-a'
const keyMap = new Map([[TEST_KEY, TENANT_A]])

function createTestApp() {
  const logger = pino({ level: 'silent' })
  const settingsStore = new TenantSettingsStore({ logger })
  const auth = createAuthMiddleware(keyMap)

  const app = express()
  app.use(express.json())
  app.use('/v1', auth, settingsRoutes({ settingsStore, db: null, logger }))
  app.use(createErrorHandler(logger))
  return { app, settingsStore }
}

// ---------------------------------------------------------------------------
// GET /v1/settings/cost-thresholds
// ---------------------------------------------------------------------------

describe('GET /v1/settings/cost-thresholds', () => {
  it('returns defaults when no custom thresholds set', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .get('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.noiseDebugPct, 5)
    assert.equal(res.body.data.reviewInfoPct, 10)
    assert.equal(res.body.data.reviewWarnPct, 20)
    assert.equal(res.body.data.isCustom, false)
  })

  it('returns custom thresholds when set', async () => {
    const { app, settingsStore } = createTestApp()
    await settingsStore.set(TENANT_A, {
      costNoiseDebugPct: 15,
      costReviewInfoPct: 25,
      costReviewWarnPct: 40,
    })

    const res = await request(app)
      .get('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.noiseDebugPct, 15)
    assert.equal(res.body.data.reviewInfoPct, 25)
    assert.equal(res.body.data.reviewWarnPct, 40)
    assert.equal(res.body.data.isCustom, true)
  })

  it('requires authentication', async () => {
    const { app } = createTestApp()

    const res = await request(app).get('/v1/settings/cost-thresholds')

    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// PUT /v1/settings/cost-thresholds
// ---------------------------------------------------------------------------

describe('PUT /v1/settings/cost-thresholds', () => {
  it('persists partial threshold updates', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ noiseDebugPct: 8 })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.noiseDebugPct, 8)
    assert.equal(res.body.data.reviewInfoPct, 10) // default
    assert.equal(res.body.data.reviewWarnPct, 20) // default
    assert.equal(res.body.data.isCustom, true)
  })

  it('persists all threshold updates', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ noiseDebugPct: 3, reviewInfoPct: 15, reviewWarnPct: 30 })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.noiseDebugPct, 3)
    assert.equal(res.body.data.reviewInfoPct, 15)
    assert.equal(res.body.data.reviewWarnPct, 30)
  })

  it('reflects updates in subsequent GET', async () => {
    const { app } = createTestApp()

    await request(app)
      .put('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ noiseDebugPct: 12 })

    const res = await request(app)
      .get('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.noiseDebugPct, 12)
    assert.equal(res.body.data.isCustom, true)
  })

  it('rejects values above 100', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ noiseDebugPct: 150 })

    assert.equal(res.status, 400)
  })

  it('rejects negative values', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ reviewInfoPct: -5 })

    assert.equal(res.status, 400)
  })

  it('accepts zero as a valid threshold', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/cost-thresholds')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ noiseDebugPct: 0 })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.noiseDebugPct, 0)
  })

  it('requires authentication', async () => {
    const { app } = createTestApp()

    const res = await request(app).put('/v1/settings/cost-thresholds').send({ noiseDebugPct: 10 })

    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/settings/spike-baseline
// ---------------------------------------------------------------------------

describe('GET /v1/settings/spike-baseline', () => {
  it('returns default of 10 when no custom baseline set', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .get('/v1/settings/spike-baseline')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.minBaseline, 10)
    assert.equal(res.body.data.isCustom, false)
  })

  it('returns custom baseline when set', async () => {
    const { app, settingsStore } = createTestApp()
    await settingsStore.set(TENANT_A, { spikeMinBaseline: 25 })

    const res = await request(app)
      .get('/v1/settings/spike-baseline')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.minBaseline, 25)
    assert.equal(res.body.data.isCustom, true)
  })

  it('requires authentication', async () => {
    const { app } = createTestApp()

    const res = await request(app).get('/v1/settings/spike-baseline')

    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// PUT /v1/settings/spike-baseline
// ---------------------------------------------------------------------------

describe('PUT /v1/settings/spike-baseline', () => {
  it('persists minBaseline update', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/spike-baseline')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ minBaseline: 20 })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.minBaseline, 20)
    assert.equal(res.body.data.isCustom, true)
  })

  it('accepts zero (suppress nothing)', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/spike-baseline')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ minBaseline: 0 })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.minBaseline, 0)
  })

  it('reflects update in subsequent GET', async () => {
    const { app } = createTestApp()

    await request(app)
      .put('/v1/settings/spike-baseline')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ minBaseline: 50 })

    const res = await request(app)
      .get('/v1/settings/spike-baseline')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.minBaseline, 50)
    assert.equal(res.body.data.isCustom, true)
  })

  it('rejects negative values', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/spike-baseline')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ minBaseline: -1 })

    assert.equal(res.status, 400)
  })

  it('rejects values above 10000', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .put('/v1/settings/spike-baseline')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ minBaseline: 99999 })

    assert.equal(res.status, 400)
  })

  it('requires authentication', async () => {
    const { app } = createTestApp()

    const res = await request(app).put('/v1/settings/spike-baseline').send({ minBaseline: 10 })

    assert.equal(res.status, 401)
  })
})
