import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
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

function createTestApp(maxWatches = 100) {
  const logger = pino({ level: 'silent' })
  const watchStore = new WatchStore(maxWatches)
  const app = express()
  app.use(express.json())
  const auth = createAuthMiddleware(keyMap)
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
    const res = await request(app)
      .post('/v1/watches')
      .send({ templateId: 'tmpl-1' })

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

    const res = await request(app)
      .get('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, ['tmpl-1', 'tmpl-2']) // sorted
    assert.equal(res.body.meta.count, 2)
  })

  it('returns empty array for no watches', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .get('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)

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

    const resA = await request(app)
      .get('/v1/watches')
      .set('Authorization', `Bearer ${TEST_KEY}`)
    const resB = await request(app)
      .get('/v1/watches')
      .set('Authorization', 'Bearer key-b')

    assert.deepEqual(resA.body.data, ['tmpl-a'])
    assert.deepEqual(resB.body.data, ['tmpl-b'])
  })
})
