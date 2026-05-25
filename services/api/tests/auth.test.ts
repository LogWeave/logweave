import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import request from 'supertest'
import { createLogger } from '../src/logger.js'
import { createAuthMiddleware, getTenantId } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'

const keyMap = new Map([
  ['key-alpha', 'tenant-a'],
  ['key-beta', 'tenant-b'],
])

function createTestApp() {
  const app = express()
  app.disable('x-powered-by')
  const logger = createLogger('silent')

  app.use(createAuthMiddleware(keyMap))

  // Echo route that returns the resolved tenant_id
  app.get('/echo-tenant', (_req, res) => {
    const tenantId = getTenantId(res)
    res.json({ tenantId })
  })

  app.use(createErrorHandler(logger))
  return app
}

describe('auth middleware', () => {
  it('resolves tenant_id from valid API key', async () => {
    const app = createTestApp()
    const res = await request(app).get('/echo-tenant').set('Authorization', 'Bearer key-alpha')

    assert.equal(res.status, 200)
    assert.equal(res.body.tenantId, 'tenant-a')
  })

  it('resolves different tenant for different key', async () => {
    const app = createTestApp()
    const res = await request(app).get('/echo-tenant').set('Authorization', 'Bearer key-beta')

    assert.equal(res.status, 200)
    assert.equal(res.body.tenantId, 'tenant-b')
  })

  it('returns 401 for invalid API key', async () => {
    const app = createTestApp()
    const res = await request(app).get('/echo-tenant').set('Authorization', 'Bearer wrong-key')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('returns 401 when Authorization header is missing', async () => {
    const app = createTestApp()
    const res = await request(app).get('/echo-tenant')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('returns 401 for wrong scheme (Basic instead of Bearer)', async () => {
    const app = createTestApp()
    const res = await request(app).get('/echo-tenant').set('Authorization', 'Basic dXNlcjpwYXNz')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('returns 401 for empty Bearer token', async () => {
    const app = createTestApp()
    const res = await request(app).get('/echo-tenant').set('Authorization', 'Bearer ')

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })
})
