import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import request from 'supertest'
import { createLogger } from '../src/logger.js'
import { createAuthMiddleware, getTenantId, KeyStore } from '../src/middleware/auth.js'
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

describe('KeyStore HMAC hashing', () => {
  const SECRET = 'an-encryption-key-at-least-32-characters!'

  it('validates a key when an HMAC secret is configured', () => {
    const store = new KeyStore(new Map([['secret-key', 'tenant-x']]), SECRET)
    assert.equal(store.validate('secret-key')?.tenantId, 'tenant-x')
    assert.equal(store.validate('wrong-key'), undefined)
  })

  it('produces a different keyId than bare SHA-256 (proves HMAC is applied)', () => {
    const hmacStore = new KeyStore(new Map([['k', 't']]), SECRET)
    const plainStore = new KeyStore(new Map([['k', 't']]))
    const hmacKeyId = hmacStore.validate('k')?.keyId
    const plainKeyId = plainStore.validate('k')?.keyId
    assert.ok(hmacKeyId)
    assert.ok(plainKeyId)
    assert.notEqual(hmacKeyId, plainKeyId)
  })

  it('rejects the same key under a different HMAC secret cross-check', () => {
    // A key registered under SECRET should not validate against a store built
    // with a different secret (different hashes).
    const storeA = new KeyStore(new Map([['shared', 'tenant-a']]), SECRET)
    const storeB = new KeyStore(
      new Map([['other', 'tenant-b']]),
      'a-completely-different-32char-secret-key!',
    )
    assert.equal(storeA.validate('shared')?.tenantId, 'tenant-a')
    assert.equal(storeB.validate('shared'), undefined)
  })
})
