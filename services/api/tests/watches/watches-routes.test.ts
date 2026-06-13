import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import { HmacSessionProvider, SESSION_COOKIE_NAME } from '../../src/auth/session.js'
import { createAuthMiddleware } from '../../src/middleware/auth.js'
import { createErrorHandler } from '../../src/middleware/error-handler.js'
import { watchRoutes } from '../../src/routes/watches.js'
import { WatchStore } from '../../src/watches/watch-store.js'

const TEST_KEY = 'test-key'
const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const keyMap = new Map([
  [TEST_KEY, TENANT_A],
  ['key-b', TENANT_B],
])

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

function createTestApp(maxWatches = 100) {
  const logger = pino({ level: 'silent' })
  const watchStore = new WatchStore({ maxPerTenant: maxWatches })
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  const auth = createAuthMiddleware(keyMap, sessionProvider)
  app.use('/v1', auth, watchRoutes({ watchStore, logger }))
  app.use(createErrorHandler(logger))
  return { app, watchStore }
}

describe('POST /v1/watches', () => {
  it('creates a watch, returns 201', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-1', templateText: 'Error in {service}' })

    assert.equal(res.status, 201)
    assert.equal(res.body.data.templateId, 'tmpl-1')
    assert.ok(res.body.meta.fetchedAt)
  })

  it('returns 400 for missing templateId', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({})

    assert.equal(res.status, 400)
  })

  it('is idempotent — same templateId twice returns 201', async () => {
    const { app } = createTestApp()
    await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-1' })

    const res = await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-1' })

    assert.equal(res.status, 201)
  })

  it('returns 400 when watch limit exceeded', async () => {
    const { app } = createTestApp(2)
    await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-1' })
    await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-2' })

    const res = await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-3' })

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'WATCH_LIMIT_EXCEEDED')
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app).post('/v1/watches').send({ templateId: 'tmpl-1' })

    assert.equal(res.status, 401)
  })
})

describe('DELETE /v1/watches/:templateId', () => {
  it('returns 204', async () => {
    const { app } = createTestApp()
    await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-1' })

    const res = await request(app)
      .delete('/v1/watches/tmpl-1')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 204)
  })

  it('tenant B cannot delete tenant A watch', async () => {
    const { app } = createTestApp()
    await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-1' })

    // Tenant B tries to delete tenant A's watch
    await request(app).delete('/v1/watches/tmpl-1').set('Authorization', 'Bearer key-b')

    // Tenant A's watch should still be there
    const res = await request(app).get('/v1/watches').set('Authorization', `Bearer ${TEST_KEY}`)
    assert.deepEqual(res.body.data, [{ templateId: 'tmpl-1' }])
  })

  it('returns 204 for nonexistent watch (idempotent)', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .delete('/v1/watches/nonexistent')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 204)
  })
})

describe('GET /v1/watches', () => {
  it('returns array of watched templateIds', async () => {
    const { app } = createTestApp()
    await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-2' })
    await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-1' })

    const res = await request(app).get('/v1/watches').set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [{ templateId: 'tmpl-1' }, { templateId: 'tmpl-2' }])
    assert.equal(res.body.meta.count, 2)
  })

  it('returns empty array for no watches', async () => {
    const { app } = createTestApp()
    const res = await request(app).get('/v1/watches').set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
    assert.equal(res.body.meta.count, 0)
  })

  it('tenant isolation — tenant A sees only their watches', async () => {
    const { app } = createTestApp()
    await request(app)
      .post('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ templateId: 'tmpl-a' })
    await request(app)
      .post('/v1/watches')
      .set('Authorization', 'Bearer key-b')
      .send({ templateId: 'tmpl-b' })

    const resA = await request(app).get('/v1/watches').set('Authorization', `Bearer ${TEST_KEY}`)
    const resB = await request(app).get('/v1/watches').set('Authorization', 'Bearer key-b')

    assert.deepEqual(resA.body.data, [{ templateId: 'tmpl-a' }])
    assert.deepEqual(resB.body.data, [{ templateId: 'tmpl-b' }])
  })
})

describe('admin guard', () => {
  it('rejects POST /watches from viewer session with 403', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/watches')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)
      .send({ templateId: 'tmpl-1' })

    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'FORBIDDEN')
  })

  it('rejects DELETE /watches/:templateId from viewer session with 403', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .delete('/v1/watches/tmpl-1')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)

    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'FORBIDDEN')
  })

  it('allows GET /watches from viewer session', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .get('/v1/watches')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)

    assert.equal(res.status, 200)
  })
})
