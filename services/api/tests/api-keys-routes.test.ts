import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express, { Router } from 'express'
import pino from 'pino'
import request from 'supertest'
import { ApiKeyStore } from '../src/auth/api-key-store.js'
import type { DbClient } from '../src/db/client.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { apiKeyRoutes } from '../src/routes/api-keys.js'

const SECRET = 'route-test-hmac-secret-must-be-at-least-32-chars'
const KEY_A = 'env-bearer-a'
const TENANT_A = 'tenant-a'
const KEY_B = 'env-bearer-b'
const TENANT_B = 'tenant-b'
const keyMap = new Map([
  [KEY_A, TENANT_A],
  [KEY_B, TENANT_B],
])
const silentLogger = pino({ level: 'silent' })

interface Row {
  tenant_id: string
  key_id: string
  key_hash: string
  key_prefix: string
  name: string
  created_at: string
  created_by: string
  revoked_at: string | null
  revoked_by: string
  version: number
  is_deleted: number
}

function mockDb(): { db: DbClient; rows: Row[] } {
  const rows: Row[] = []
  const db = {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      const latest = new Map<string, Row>()
      for (const r of rows) {
        const k = `${r.tenant_id}\0${r.key_id}`
        const cur = latest.get(k)
        if (!cur || r.version >= cur.version) latest.set(k, r)
      }
      let result = [...latest.values()].filter((r) => r.is_deleted === 0)
      const tenantFilter = params.query_params.tenant_id as string | undefined
      const keyIdFilter = params.query_params.key_id as string | undefined
      if (tenantFilter) result = result.filter((r) => r.tenant_id === tenantFilter)
      if (keyIdFilter) result = result.filter((r) => r.key_id === keyIdFilter)
      if (/ORDER BY created_at DESC/.test(params.query)) {
        result.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      }
      return result
    },
    insert: async (params: { table: string; values: unknown[] }) => {
      for (const v of params.values) rows.push(v as Row)
    },
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, rows }
}

function createTestApp() {
  const { db, rows } = mockDb()
  const apiKeyStore = new ApiKeyStore({ db, logger: silentLogger, hmacSecret: SECRET })

  const app = express()
  app.use(express.json())
  const v1 = Router()
  // The env key map gives KEY_A → TENANT_A → admin role (Bearer auth defaults
  // to admin). That's how an admin in our model authenticates.
  v1.use(
    createAuthMiddleware({
      envKeys: keyMap,
      apiKeyStore,
      logger: silentLogger,
    }),
  )
  v1.use(apiKeyRoutes({ db, logger: silentLogger, apiKeyStore }))
  app.use('/v1', v1)
  app.use(createErrorHandler(silentLogger))
  return { app, db, rows, apiKeyStore }
}

describe('POST /v1/api-keys', () => {
  it('creates a key and returns the raw value exactly once', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: 'production-ingest' })

    assert.equal(res.status, 201)
    assert.equal(typeof res.body.data.key, 'string', 'raw key must be returned')
    assert.match(res.body.data.key, /^lw_[a-z2-7]{32}$/)
    assert.equal(res.body.data.name, 'production-ingest')
    assert.equal(res.body.data.tenantId, TENANT_A)
    assert.equal(res.body.data.prefix.startsWith('lw_'), true)
    assert.ok(res.body.data.keyId, 'returns the keyId')
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app).post('/v1/api-keys').send({ name: 'x' })
    assert.equal(res.status, 401)
  })

  it('returns 400 when name is missing', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({})
    assert.equal(res.status, 400)
  })

  it('returns 400 when name is empty string', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: '' })
    assert.equal(res.status, 400)
  })

  it('a key created by tenant A actually authenticates as tenant A on subsequent requests', async () => {
    const { app } = createTestApp()
    // Create a key as tenant A
    const created = await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: 'new-key' })
    const rawKey = created.body.data.key as string

    // Use the new key to list keys — must return tenant A's keys
    const listed = await request(app).get('/v1/api-keys').set('Authorization', `Bearer ${rawKey}`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.data.length, 1)
    assert.equal(listed.body.data[0].tenantId, TENANT_A)
  })
})

describe('GET /v1/api-keys', () => {
  it('returns active keys for the current tenant, prefix only — no raw key', async () => {
    const { app } = createTestApp()

    await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: 'one' })
    await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: 'two' })

    const res = await request(app).get('/v1/api-keys').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 2)
    for (const item of res.body.data) {
      assert.ok(!('key' in item), 'list response must not include raw key')
      assert.ok(!('keyHash' in item), 'list response must not include hash')
      assert.ok(!('hash' in item), 'list response must not include hash')
      assert.match(item.prefix, /^lw_/, 'prefix must be present')
    }
  })

  it('tenant isolation — tenant B cannot see tenant A keys', async () => {
    const { app } = createTestApp()

    await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: 'a-private' })

    const res = await request(app).get('/v1/api-keys').set('Authorization', `Bearer ${KEY_B}`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 0, 'tenant B sees no keys')
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app).get('/v1/api-keys')
    assert.equal(res.status, 401)
  })
})

describe('DELETE /v1/api-keys/:keyId', () => {
  it('revokes a tenant key and the raw key stops working', async () => {
    const { app } = createTestApp()

    const created = await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: 'to-revoke' })
    const { keyId, key: rawKey } = created.body.data

    // Sanity: key works
    const before = await request(app).get('/v1/api-keys').set('Authorization', `Bearer ${rawKey}`)
    assert.equal(before.status, 200)

    // Revoke
    const revoke = await request(app)
      .delete(`/v1/api-keys/${keyId}`)
      .set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(revoke.status, 204)

    // Key should no longer authenticate
    const after = await request(app).get('/v1/api-keys').set('Authorization', `Bearer ${rawKey}`)
    assert.equal(after.status, 401, 'revoked key must not auth')

    // And the key disappears from list
    const list = await request(app).get('/v1/api-keys').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(list.body.data.length, 0)
  })

  it('tenant isolation — tenant B cannot revoke tenant A keys', async () => {
    const { app } = createTestApp()

    const created = await request(app)
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: 'a-only' })
    const { keyId, key: rawKey } = created.body.data

    // Tenant B attempts revoke
    const revoke = await request(app)
      .delete(`/v1/api-keys/${keyId}`)
      .set('Authorization', `Bearer ${KEY_B}`)
    assert.equal(revoke.status, 404, 'cross-tenant revoke returns 404')

    // Tenant A's key still works
    const after = await request(app).get('/v1/api-keys').set('Authorization', `Bearer ${rawKey}`)
    assert.equal(after.status, 200)
  })

  it('returns 404 for unknown keyId', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .delete('/v1/api-keys/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(res.status, 404)
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app).delete('/v1/api-keys/abc')
    assert.equal(res.status, 401)
  })
})
