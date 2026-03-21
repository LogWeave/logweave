import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express, { Router } from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../../src/db/client.js'
import { createAuthMiddleware } from '../../src/middleware/auth.js'
import { createErrorHandler } from '../../src/middleware/error-handler.js'
import { TailBuffer } from '../../src/tail/buffer.js'
import { tailRoutes } from '../../src/routes/tail.js'
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

  const app = express()
  app.use(express.json())
  const v1 = Router()
  v1.use(createAuthMiddleware(new Map(keyMap)))
  v1.use(tailRoutes({ tailBuffer, settingsStore, db, logger }))
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return { app, tailBuffer, settingsStore }
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
// GET /v1/tail (SSE) — basic checks only (SSE needs special handling)
// ---------------------------------------------------------------------------

describe('GET /v1/tail (SSE)', () => {
  it('returns 403 when tail disabled', async () => {
    const { app } = createTestApp({ tailMode: 'disabled' })

    const res = await request(app)
      .get('/v1/tail')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'TAIL_DISABLED')
  })

  it('returns 403 when tail_mode not set', async () => {
    const { app } = createTestApp()

    const res = await request(app)
      .get('/v1/tail')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 403)
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp({ tailMode: 'metadata' })
    const res = await request(app).get('/v1/tail')
    assert.equal(res.status, 401)
  })
})
