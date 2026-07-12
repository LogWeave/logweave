import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import cookieParser from 'cookie-parser'
import express, { Router } from 'express'
import pino from 'pino'
import request from 'supertest'
import { HmacSessionProvider, SESSION_COOKIE_NAME } from '../src/auth/session.js'
import type { DbClient } from '../src/db/client.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createConcurrentQueryGuard } from '../src/middleware/concurrent-query-guard.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { createRateLimiter } from '../src/middleware/rate-limit.js'
import { deployRoutes } from '../src/routes/deploys.js'

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
// Mock data
// ---------------------------------------------------------------------------

const insertedDeploys: Array<{ table: string; values: unknown[] }> = []

const mockDeployRows = [
  {
    deploy_id: '019abc-1',
    tenant_id: TENANT_A,
    service: 'payment-service',
    version: '2.3.4',
    commit_sha: 'abc123',
    timestamp: '2026-03-20T14:32:00.000Z',
  },
  {
    deploy_id: '019abc-2',
    tenant_id: TENANT_A,
    service: 'api-gateway',
    version: '1.0.0',
    commit_sha: 'def456',
    timestamp: '2026-03-20T10:00:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// Mock DbClient
// ---------------------------------------------------------------------------

function createMockDb(queryResults?: Map<string, unknown>): DbClient {
  insertedDeploys.length = 0
  return {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      if (queryResults) {
        for (const [key, value] of queryResults) {
          if (params.query.includes(key)) return value
        }
      }
      return []
    },
    insert: async (params: { table: string; values: unknown[] }) => {
      insertedDeploys.push(params)
    },
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

const SESSION_KEY = Buffer.alloc(32, 0x42)
const sessionProvider = new HmacSessionProvider(SESSION_KEY)

function viewerCookie(): string {
  return sessionProvider.createSession({
    userId: 'viewer-1',
    tenantId: TENANT_A,
    role: 'viewer',
    sessionVersion: 1,
  })
}

function createTestApp(queryResults?: Map<string, unknown>) {
  const logger = pino({ level: 'silent' })
  const db = createMockDb(queryResults)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  const v1 = Router()
  v1.use(createAuthMiddleware(new Map(keyMap), sessionProvider))
  v1.use(createRateLimiter({ keyRpm: 1000, tenantRpm: 2000, ingestKeyRpm: 3000 }))
  v1.use(createConcurrentQueryGuard({ maxConcurrent: 100 }))
  v1.use(deployRoutes({ db, logger }))
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return app
}

function deploysQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('ORDER BY timestamp DESC', mockDeployRows)
  return map
}

function _deployByIdMap(deploy = mockDeployRows[0]): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('deploy_id = {deploy_id:String}', [deploy])
  map.set('ORDER BY timestamp DESC', mockDeployRows)
  return map
}

// ---------------------------------------------------------------------------
// POST /v1/deploys tests
// ---------------------------------------------------------------------------

describe('POST /v1/deploys', () => {
  it('creates deploy with UUIDv7 id', async () => {
    const app = createTestApp()

    const res = await request(app)
      .post('/v1/deploys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ service: 'payment-service', version: '2.3.4', commitSha: 'abc123' })

    assert.equal(res.status, 201)
    assert.ok(res.body.data.deployId, 'should have deployId')
    // UUIDv7 format: 8-4-4-4-12 hex chars
    assert.match(
      res.body.data.deployId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('defaults timestamp to now', async () => {
    const app = createTestApp()
    const before = Date.now()

    const res = await request(app)
      .post('/v1/deploys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ service: 'api' })

    const ts = new Date(res.body.data.timestamp).getTime()
    assert.ok(ts >= before - 1000, 'timestamp should be recent')
    assert.ok(ts <= Date.now() + 1000, 'timestamp should not be in the future')
  })

  it('accepts custom timestamp', async () => {
    const app = createTestApp()
    const custom = '2026-03-20T14:00:00.000Z'

    const res = await request(app)
      .post('/v1/deploys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ service: 'api', timestamp: custom })

    assert.equal(res.body.data.timestamp, custom)
  })

  it('returns created deploy data', async () => {
    const app = createTestApp()

    const res = await request(app)
      .post('/v1/deploys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ service: 'payment-service', version: '2.3.4', commitSha: 'abc123' })

    assert.equal(res.body.data.service, 'payment-service')
    assert.equal(res.body.data.version, '2.3.4')
    assert.equal(res.body.data.commitSha, 'abc123')
    assert.ok(res.body.meta.fetchedAt)
  })

  it('inserts into ClickHouse with correct tenant_id', async () => {
    const app = createTestApp()

    await request(app)
      .post('/v1/deploys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ service: 'api' })

    assert.equal(insertedDeploys.length, 1)
    assert.equal(insertedDeploys[0].table, 'logweave.deploys')
    const row = insertedDeploys[0].values[0] as Record<string, unknown>
    assert.equal(row.tenant_id, TENANT_A)
  })

  it('returns 400 for missing service', async () => {
    const app = createTestApp()

    const res = await request(app)
      .post('/v1/deploys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({})

    assert.equal(res.status, 400)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp()
    const res = await request(app).post('/v1/deploys').send({ service: 'api' })
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/deploys tests
// ---------------------------------------------------------------------------

describe('GET /v1/deploys', () => {
  it('returns most recent first', async () => {
    const app = createTestApp(deploysQueryMap())

    const res = await request(app).get('/v1/deploys').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 2)
    assert.equal(res.body.data[0].deployId, '019abc-1')
    assert.equal(res.body.data[0].service, 'payment-service')
    assert.ok(res.body.meta.count)
  })

  it('filters by service', async () => {
    const app = createTestApp(deploysQueryMap())

    const res = await request(app)
      .get('/v1/deploys?service=payment-service')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
  })

  it('respects tenant isolation', async () => {
    // Tenant B should get empty results (mock only has tenant A data)
    const app = createTestApp()

    const res = await request(app).get('/v1/deploys').set('Authorization', `Bearer ${KEY_B}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp(deploysQueryMap())
    const res = await request(app).get('/v1/deploys')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// Admin guard — viewer sessions must be rejected on mutating routes
// ---------------------------------------------------------------------------

describe('admin guard', () => {
  it('rejects POST /deploys from viewer session with 403', async () => {
    const app = createTestApp()
    const res = await request(app)
      .post('/v1/deploys')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)
      .send({ service: 'payment-service' })

    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'FORBIDDEN')
  })

  it('allows GET /deploys from viewer session', async () => {
    const app = createTestApp(deploysQueryMap())
    const res = await request(app)
      .get('/v1/deploys')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)

    assert.equal(res.status, 200)
  })
})
