import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createMcpDetectMiddleware } from '../src/middleware/mcp-detect.js'
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
  const mcpDetect = createMcpDetectMiddleware({ settingsStore, logger })

  const app = express()
  app.use(express.json())
  app.use('/v1', auth, mcpDetect, settingsRoutes({ settingsStore, db: null, logger }))
  app.use(createErrorHandler(logger))
  return { app, settingsStore }
}

// ---------------------------------------------------------------------------
// GET /v1/settings/onboarding-status
// ---------------------------------------------------------------------------

describe('GET /v1/settings/onboarding-status', () => {
  it('returns all-false for a fresh tenant (no db)', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .get('/v1/settings/onboarding-status')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.hasEvents, false)
    assert.equal(res.body.data.mcpConnected, false)
    assert.equal(res.body.data.clusteringConfigured, false)
    assert.equal(res.body.data.dismissed, false)
  })

  it('reflects mcpConnected when lastMcpConnectionAt is set', async () => {
    const { app, settingsStore } = createTestApp()
    await settingsStore.set(TENANT_A, { lastMcpConnectionAt: '2026-03-25T00:00:00Z' })

    const res = await request(app)
      .get('/v1/settings/onboarding-status')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.mcpConnected, true)
  })

  it('reflects dismissed when onboardingDismissedAt is set', async () => {
    const { app, settingsStore } = createTestApp()
    await settingsStore.set(TENANT_A, { onboardingDismissedAt: '2026-03-25T00:00:00Z' })

    const res = await request(app)
      .get('/v1/settings/onboarding-status')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.dismissed, true)
  })

  it('requires authentication', async () => {
    const { app } = createTestApp()
    const res = await request(app).get('/v1/settings/onboarding-status')

    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// POST /v1/settings/onboarding/dismiss
// ---------------------------------------------------------------------------

describe('POST /v1/settings/onboarding/dismiss', () => {
  it('sets onboardingDismissedAt and returns dismissed: true', async () => {
    const { app, settingsStore } = createTestApp()
    const res = await request(app)
      .post('/v1/settings/onboarding/dismiss')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.dismissed, true)

    const settings = settingsStore.get(TENANT_A)
    assert.ok(settings.onboardingDismissedAt)
  })

  it('is idempotent — second dismiss does not overwrite timestamp', async () => {
    const { app, settingsStore } = createTestApp()
    const firstTs = '2026-03-20T00:00:00.000Z'
    await settingsStore.set(TENANT_A, { onboardingDismissedAt: firstTs })

    const res = await request(app)
      .post('/v1/settings/onboarding/dismiss')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(settingsStore.get(TENANT_A).onboardingDismissedAt, firstTs)
  })

  it('requires authentication', async () => {
    const { app } = createTestApp()
    const res = await request(app).post('/v1/settings/onboarding/dismiss')

    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// MCP User-Agent detection middleware
// ---------------------------------------------------------------------------

describe('MCP User-Agent detection middleware', () => {
  it('stamps lastMcpConnectionAt on first request with MCP user-agent', async () => {
    const { app, settingsStore } = createTestApp()

    await request(app)
      .get('/v1/settings/onboarding-status')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .set('User-Agent', '@logweave/mcp v1.0.0')

    // Give the fire-and-forget promise a tick to resolve
    await new Promise((resolve) => setTimeout(resolve, 10))

    const settings = settingsStore.get(TENANT_A)
    assert.ok(settings.lastMcpConnectionAt, 'expected lastMcpConnectionAt to be set')
  })

  it('does not stamp for non-MCP user-agents', async () => {
    const { app, settingsStore } = createTestApp()

    await request(app)
      .get('/v1/settings/onboarding-status')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .set('User-Agent', 'curl/7.88.0')

    await new Promise((resolve) => setTimeout(resolve, 10))

    const settings = settingsStore.get(TENANT_A)
    assert.equal(settings.lastMcpConnectionAt, undefined)
  })

  it('does not overwrite existing lastMcpConnectionAt', async () => {
    const { app, settingsStore } = createTestApp()
    const originalTs = '2026-03-20T00:00:00.000Z'
    await settingsStore.set(TENANT_A, { lastMcpConnectionAt: originalTs })

    await request(app)
      .get('/v1/settings/onboarding-status')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .set('User-Agent', '@logweave/mcp v2.0.0')

    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(settingsStore.get(TENANT_A).lastMcpConnectionAt, originalTs)
  })
})

// ---------------------------------------------------------------------------
// TenantSettings fields persistence (in-memory, no DB)
// ---------------------------------------------------------------------------

describe('TenantSettings onboarding fields', () => {
  it('round-trips lastMcpConnectionAt via set/get', async () => {
    const store = new TenantSettingsStore()
    await store.set('t1', { lastMcpConnectionAt: '2026-03-25T12:00:00Z' })
    assert.equal(store.get('t1').lastMcpConnectionAt, '2026-03-25T12:00:00Z')
  })

  it('round-trips onboardingDismissedAt via set/get', async () => {
    const store = new TenantSettingsStore()
    await store.set('t1', { onboardingDismissedAt: '2026-03-25T12:00:00Z' })
    assert.equal(store.get('t1').onboardingDismissedAt, '2026-03-25T12:00:00Z')
  })

  it('preserves existing fields when adding onboarding fields', async () => {
    const store = new TenantSettingsStore()
    await store.set('t1', { tailMode: 'metadata' })
    await store.set('t1', { lastMcpConnectionAt: '2026-03-25T12:00:00Z' })

    const settings = store.get('t1')
    assert.equal(settings.tailMode, 'metadata')
    assert.equal(settings.lastMcpConnectionAt, '2026-03-25T12:00:00Z')
  })
})
