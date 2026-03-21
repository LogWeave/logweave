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
import { connectorRoutes } from '../src/routes/connectors.js'

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

// ---------------------------------------------------------------------------
// Mock DbClient
// ---------------------------------------------------------------------------

const commands: Array<{ query: string }> = []

function createMockDb(queryResults?: Map<string, unknown>): DbClient {
  commands.length = 0
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
    command: async (params: { query: string }) => {
      commands.push(params)
    },
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
  v1.use(connectorRoutes({ db, logger }))
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return app
}

function connectorQueryMap(): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('tenant_connectors FINAL', [mockConnectorRow])
  return map
}

// ---------------------------------------------------------------------------
// POST /v1/connectors
// ---------------------------------------------------------------------------

describe('POST /v1/connectors', () => {
  it('creates connector with UUIDv7 id', async () => {
    const app = createTestApp()

    const res = await request(app)
      .post('/v1/connectors')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        name: 'Dev S3',
        config: {
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
        },
      })

    assert.equal(res.status, 201)
    assert.ok(res.body.data.connectorId)
    assert.equal(res.body.data.name, 'Dev S3')
    assert.equal(res.body.data.type, 's3')
    // secretAccessKey should be redacted
    assert.equal(res.body.data.config.secretAccessKey, '***')
    assert.equal(res.body.data.config.bucket, 'logweave-logs')
  })

  it('rejects secretAccessKey without endpoint', async () => {
    const app = createTestApp()

    const res = await request(app)
      .post('/v1/connectors')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        name: 'Bad Config',
        config: {
          type: 's3',
          bucket: 'my-bucket',
          prefix: '',
          pathPattern: '{prefix}{service}/{year}/{month}/{day}/',
          region: 'us-east-1',
          logFormat: 'jsonl',
          compression: 'none',
          secretAccessKey: 'should-not-be-here',
        },
      })

    assert.equal(res.status, 400)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp()
    const res = await request(app)
      .post('/v1/connectors')
      .send({ name: 'Test', config: {} })
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/connectors
// ---------------------------------------------------------------------------

describe('GET /v1/connectors', () => {
  it('returns connectors with redacted secrets', async () => {
    const app = createTestApp(connectorQueryMap())

    const res = await request(app)
      .get('/v1/connectors')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 1)
    assert.equal(res.body.data[0].name, 'Dev S3')
    assert.equal(res.body.data[0].config.secretAccessKey, '***')
    assert.equal(res.body.meta.count, 1)
  })

  it('returns empty array when no connectors', async () => {
    const app = createTestApp()

    const res = await request(app)
      .get('/v1/connectors')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp()
    const res = await request(app).get('/v1/connectors')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// DELETE /v1/connectors/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/connectors/:id', () => {
  it('deletes existing connector', async () => {
    const map = new Map<string, unknown>()
    map.set('connector_id = {connector_id:String}', [mockConnectorRow])
    const app = createTestApp(map)

    const res = await request(app)
      .delete('/v1/connectors/019abc-conn-1')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 204)
  })

  it('returns 404 for unknown connector', async () => {
    const app = createTestApp()

    const res = await request(app)
      .delete('/v1/connectors/nonexistent')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 404)
  })

  it('returns 401 without auth', async () => {
    const app = createTestApp()
    const res = await request(app).delete('/v1/connectors/019abc-conn-1')
    assert.equal(res.status, 401)
  })
})
