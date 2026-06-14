import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../src/db/client.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { tailRoutes } from '../src/routes/tail.js'
import type { TailBuffer } from '../src/tail/buffer.js'
import type { TailTokenStore } from '../src/tail/token-store.js'
import type { TenantSettingsStore } from '../src/watches/tenant-settings.js'

const API_KEY = 'test-key'
const TENANT_ID = 'tenant-test'
const keyMap = new Map([[API_KEY, TENANT_ID]])

// Captures the filter options the route hands to the buffer so we can assert
// min_anomaly is passed through uncapped.
function createTestApp(settings: { tailMode?: string } = {}) {
  const logger = pino({ level: 'silent' })
  const recentCalls: Array<Record<string, unknown>> = []

  const tailBuffer = {
    recent: (_t: string, opts: Record<string, unknown>) => {
      recentCalls.push(opts)
      return { events: [], cursor: 0 }
    },
    since: (_t: string, _c: number, opts: Record<string, unknown>) => {
      recentCalls.push(opts)
      return { events: [], cursor: 0 }
    },
    stats: () => ({}),
  } as unknown as TailBuffer

  const settingsStore = {
    get: () => settings,
  } as unknown as TenantSettingsStore

  const deps = {
    tailBuffer,
    settingsStore,
    tailTokenStore: {} as TailTokenStore,
    db: {} as DbClient,
    logger,
  }

  const app = express()
  app.use('/v1', createAuthMiddleware(keyMap), tailRoutes(deps))
  app.use(createErrorHandler(logger))
  return { app, recentCalls }
}

describe('GET /v1/tail/poll min_anomaly filter', () => {
  // Real anomaly scores are unbounded above (≥1.0 = elevated). The filter must
  // accept values > 1.0 — the previous .max(1) cap hid all genuine anomalies.
  for (const value of [0, 0.5, 1.0, 3.0, 10.0, 100]) {
    it(`accepts and passes through min_anomaly=${value}`, async () => {
      const { app, recentCalls } = createTestApp()
      const res = await request(app)
        .get(`/v1/tail/poll?minAnomaly=${value}`)
        .set('Authorization', `Bearer ${API_KEY}`)

      assert.equal(res.status, 200)
      assert.equal(recentCalls.length, 1)
      assert.equal(recentCalls[0]?.minAnomalyScore, value)
    })
  }

  it('rejects a negative min_anomaly', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .get('/v1/tail/poll?minAnomaly=-1')
      .set('Authorization', `Bearer ${API_KEY}`)

    assert.equal(res.status, 400)
  })
})

describe('GET /v1/tail/poll tail_mode default', () => {
  // On a fresh install no tailMode is set. The poll path must default to
  // 'metadata' (matching local-bus + the SSE path) so the MCP live_tail tool
  // returns events without any "enable tail in settings" step.
  it('queries the buffer when tailMode is unset (defaults to metadata)', async () => {
    const { app, recentCalls } = createTestApp({})
    const res = await request(app)
      .get('/v1/tail/poll')
      .set('Authorization', `Bearer ${API_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(recentCalls.length, 1)
    // No "live tail is disabled" guidance on the fresh-install happy path.
    assert.equal(res.body.meta?.message, undefined)
  })

  it('queries the buffer when tailMode is metadata', async () => {
    const { app, recentCalls } = createTestApp({ tailMode: 'metadata' })
    const res = await request(app)
      .get('/v1/tail/poll')
      .set('Authorization', `Bearer ${API_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(recentCalls.length, 1)
  })

  it('returns no events and does not query the buffer when tailMode is disabled', async () => {
    const { app, recentCalls } = createTestApp({ tailMode: 'disabled' })
    const res = await request(app)
      .get('/v1/tail/poll')
      .set('Authorization', `Bearer ${API_KEY}`)

    assert.equal(res.status, 200)
    assert.equal(recentCalls.length, 0)
    assert.deepEqual(res.body.data.events, [])
  })
})
