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
import { rawLogsRoutes } from '../src/routes/raw-logs.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_A = 'key-a'
const TENANT_A = 'tenant-a'
const keyMap = new Map([[KEY_A, TENANT_A]])

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockConnectorRow = {
  tenant_id: TENANT_A,
  connector_id: '019abc-conn-1',
  name: 'Dev S3',
  type: 's3',
  config: JSON.stringify({
    type: 's3',
    bucket: 'logweave-logs',
    prefix: 'logs/',
    pathPattern: '{prefix}{service}/{year}/{month}/{day}/{hour}/',
    region: 'us-east-1',
    endpoint: 'http://minio:9002',
    forcePathStyle: true,
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    logFormat: 'jsonl',
    compression: 'none',
  }),
  created_at: '2026-03-21T10:00:00.000Z',
  updated_at: '2026-03-21T10:00:00.000Z',
}

const mockTemplateRow = {
  template_text: 'Connection from <IP> timed out after <ID>ms',
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
  v1.use(rawLogsRoutes({ db, logger }))
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return app
}

// ---------------------------------------------------------------------------
// GET /v1/templates/:id/raw-logs
// ---------------------------------------------------------------------------

describe('GET /v1/templates/:id/raw-logs', () => {
  it('returns graceful message when no connector configured', async () => {
    const map = new Map<string, unknown>()
    // template found but no connectors
    map.set('template_registry FINAL', [mockTemplateRow])
    map.set('tenant_connectors FINAL', [])
    const app = createTestApp(map)

    const res = await request(app)
      .get('/v1/templates/tpl-1/raw-logs?service=payments')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.lines, [])
    assert.ok(res.body.meta.message)
    assert.ok(res.body.meta.message.includes('No log source connector configured'))
  })

  it('returns 404 for unknown template', async () => {
    const map = new Map<string, unknown>()
    map.set('tenant_connectors FINAL', [mockConnectorRow])
    // template not found — empty result for template_registry
    const app = createTestApp(map)

    const res = await request(app)
      .get('/v1/templates/nonexistent/raw-logs?service=payments')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'NOT_FOUND')
  })

  it('requires service query param', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/templates/tpl-1/raw-logs')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 400)
  })

  it('accepts hours and limit params', async () => {
    const map = new Map<string, unknown>()
    map.set('tenant_connectors FINAL', [])
    const app = createTestApp(map)

    const res = await request(app)
      .get('/v1/templates/tpl-1/raw-logs?service=payments&hours=2&limit=10')
      .set('Authorization', `Bearer ${KEY_A}`)

    // Should return 200 (graceful degradation) with the params reflected in meta
    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 2)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp()
    const res = await request(app).get('/v1/templates/tpl-1/raw-logs?service=payments')
    assert.equal(res.status, 401)
  })

  it('returns standard response envelope', async () => {
    const map = new Map<string, unknown>()
    map.set('tenant_connectors FINAL', [])
    const app = createTestApp(map)

    const res = await request(app)
      .get('/v1/templates/tpl-1/raw-logs?service=payments')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.ok(res.body.data)
    assert.ok(res.body.meta)
    assert.ok(res.body.meta.fetchedAt)
    assert.ok(res.body.meta.timeRange)
    assert.ok(res.body.meta.dataRetention)
  })
})
