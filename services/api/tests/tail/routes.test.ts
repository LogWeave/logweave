import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express, { Router } from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../../src/db/client.js'
import { createAuthMiddleware } from '../../src/middleware/auth.js'
import { createErrorHandler } from '../../src/middleware/error-handler.js'
import { TailBuffer } from '../../src/tail/buffer.js'
import { TailTokenStore } from '../../src/tail/token-store.js'
import { tailRoutes, tailSseRoute } from '../../src/routes/tail.js'
import { TenantSettingsStore } from '../../src/watches/tenant-settings.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_A = 'key-a'
const TENANT_A = 'tenant-a'
const keyMap = new Map([[KEY_A, TENANT_A]])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb(): DbClient {
  return {
    query: async () => [],
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

function createTestApp(options?: { tailMode?: string; bufferEvents?: number }) {
  const logger = pino({ level: 'silent' })
  const db = createMockDb()
  const tailBuffer = new TailBuffer({ bufferSize: 1000 })
  const settingsStore = new TenantSettingsStore()

  // Set tail mode
  if (options?.tailMode) {
    settingsStore.set(TENANT_A, { tailMode: options.tailMode as 'disabled' | 'metadata' | 'preprocessed' })
  }

  // Pre-fill buffer with events
  if (options?.bufferEvents) {
    for (let i = 0; i < options.bufferEvents; i++) {
      tailBuffer.push(TENANT_A, {
        timestamp: new Date(Date.now() - (options.bufferEvents - i) * 100).toISOString(),
        service: i % 2 === 0 ? 'payments' : 'gateway',
        level: i % 3 === 0 ? 'ERROR' : 'INFO',
        templateId: `tpl-${i % 5}`,
        templateText: `Template pattern ${i % 5}`,
        anomalyScore: i % 4 === 0 ? 0.8 : 0.1,
        statusCode: i % 3 === 0 ? 500 : 200,
        durationMs: 100 + i,
        traceId: `trace-${i}`,
        route: '/checkout',
      })
    }
  }

  const tailTokenStore = new TailTokenStore()

  const app = express()
  app.use(express.json())
  // SSE route (own auth via ?token=) — mounted before auth middleware
  app.use('/v1', tailSseRoute({ tailBuffer, settingsStore, tailTokenStore, db, logger }))
  const v1 = Router()
  v1.use(createAuthMiddleware(new Map(keyMap)))
  v1.use(tailRoutes({ tailBuffer, settingsStore, tailTokenStore, db, logger }))
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return { app, tailBuffer, settingsStore, tailTokenStore }
}

// ---------------------------------------------------------------------------
// GET /v1/tail/poll
// ---------------------------------------------------------------------------

describe('GET /v1/tail/poll', () => {
  it('returns events when tail enabled', async () => {
    const { app } = createTestApp({ tailMode: 'metadata', bufferEvents: 10 })

    const res = await request(app)
      .get('/v1/tail/poll?seconds=30')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.ok(res.body.data.events.length > 0)
    assert.ok(res.body.data.cursor > 0)
  })

  it('returns disabled message when tail_mode=disabled', async () => {
    const { app } = createTestApp({ tailMode: 'disabled' })

    const res = await request(app)
      .get('/v1/tail/poll')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.events, [])
    assert.ok(res.body.meta.message)
    assert.ok(res.body.meta.message.includes('not enabled'))
  })

  it('returns disabled message when tail_mode not set', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .get('/v1/tail/poll')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.ok(res.body.meta.message)
  })

  it('filters by service', async () => {
    const { app } = createTestApp({ tailMode: 'metadata', bufferEvents: 20 })

    const res = await request(app)
      .get('/v1/tail/poll?service=payments')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.ok(res.body.data.events.every((e: Record<string, unknown>) => e.service === 'payments'))
  })

  it('filters by level', async () => {
    const { app } = createTestApp({ tailMode: 'metadata', bufferEvents: 20 })

    const res = await request(app)
      .get('/v1/tail/poll?level=ERROR')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.ok(res.body.data.events.every((e: Record<string, unknown>) => e.level === 'ERROR'))
  })

  it('returns only new events with cursor', async () => {
    const { app, tailBuffer } = createTestApp({ tailMode: 'metadata', bufferEvents: 5 })

    const first = await request(app)
      .get('/v1/tail/poll?seconds=60')
      .set('Authorization', `Bearer ${KEY_A}`)

    const cursor = first.body.data.cursor

    // Push more events
    tailBuffer.push(TENANT_A, {
      timestamp: new Date().toISOString(),
      service: 'new-service',
      level: 'WARN',
      templateId: 'tpl-new',
      templateText: 'New event',
      anomalyScore: 0,
      statusCode: 200,
      durationMs: 50,
      traceId: 'trace-new',
      route: '/new',
    })

    const second = await request(app)
      .get(`/v1/tail/poll?cursor=${cursor}`)
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(second.body.data.events.length, 1)
    assert.equal(second.body.data.events[0].service, 'new-service')
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp({ tailMode: 'metadata' })
    const res = await request(app).get('/v1/tail/poll')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/tail/stats
// ---------------------------------------------------------------------------

describe('GET /v1/tail/stats', () => {
  it('returns buffer metrics', async () => {
    const { app } = createTestApp({ tailMode: 'metadata', bufferEvents: 5 })

    const res = await request(app)
      .get('/v1/tail/stats')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.tenants, 1)
    assert.equal(res.body.data.totalEvents, 5)
    assert.ok(res.body.data.memoryBytes > 0)
    assert.equal(res.body.data.connectionsActive, 0)
  })
})

// ---------------------------------------------------------------------------
// POST /v1/tail/token — short-lived SSE token exchange
// ---------------------------------------------------------------------------

describe('POST /v1/tail/token', () => {
  it('returns a token when authenticated', async () => {
    const { app } = createTestApp({ tailMode: 'metadata' })
    const res = await request(app)
      .post('/v1/tail/token')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.ok(res.body.data.token)
    assert.equal(typeof res.body.data.token, 'string')
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp({ tailMode: 'metadata' })
    const res = await request(app).post('/v1/tail/token')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// TailTokenStore
// ---------------------------------------------------------------------------

describe('TailTokenStore', () => {
  it('issues and validates a token', () => {
    const store = new TailTokenStore()
    const token = store.issue('tenant-1')
    assert.equal(store.validate(token), 'tenant-1')
  })

  it('returns undefined for unknown token', () => {
    const store = new TailTokenStore()
    assert.equal(store.validate('nonexistent'), undefined)
  })

  it('returns undefined for expired token', () => {
    const store = new TailTokenStore(1) // 1ms TTL
    const token = store.issue('tenant-1')
    // Wait for expiry
    const start = Date.now()
    while (Date.now() - start < 5) { /* busy-wait */ }
    assert.equal(store.validate(token), undefined)
  })

  it('does not consume token (reusable within TTL)', () => {
    const store = new TailTokenStore()
    const token = store.issue('tenant-1')
    assert.equal(store.validate(token), 'tenant-1')
    assert.equal(store.validate(token), 'tenant-1')
  })
})

// ---------------------------------------------------------------------------
// GET /v1/tail (SSE) — token-based auth
// ---------------------------------------------------------------------------

describe('GET /v1/tail (SSE)', () => {
  it('returns 403 when tail disabled (via token)', async () => {
    const { app, tailTokenStore } = createTestApp({ tailMode: 'disabled' })
    const token = tailTokenStore.issue(TENANT_A)

    const res = await request(app)
      .get(`/v1/tail?token=${token}`)

    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'TAIL_DISABLED')
  })

  it('returns 401 with invalid token', async () => {
    const { app } = createTestApp({ tailMode: 'metadata' })
    const res = await request(app).get('/v1/tail?token=bad-token')
    assert.equal(res.status, 401)
  })

  it('returns 401 without any auth', async () => {
    const { app } = createTestApp({ tailMode: 'metadata' })
    const res = await request(app).get('/v1/tail')
    assert.equal(res.status, 401)
  })
})
