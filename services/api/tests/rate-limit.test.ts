import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express, { Router } from 'express'
import request from 'supertest'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createConcurrentQueryGuard } from '../src/middleware/concurrent-query-guard.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { createRateLimiter } from '../src/middleware/rate-limit.js'
import pino from 'pino'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const KEY_A = 'key-a'
const KEY_B = 'key-b'
const TENANT = 'tenant-1'
const keyMap = new Map([
  [KEY_A, TENANT],
  [KEY_B, TENANT],
])

function createRateLimitApp(opts: { keyRpm: number; tenantRpm: number; ingestKeyRpm: number }) {
  const logger = pino({ level: 'silent' })
  const app = express()
  app.use(express.json())

  const v1 = Router()
  v1.use(createAuthMiddleware(new Map(keyMap)))
  v1.use(createRateLimiter(opts))
  v1.get('/test', (_req, res) => res.json({ ok: true }))
  v1.post('/ingest/batch', (_req, res) => res.json({ ok: true }))
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return app
}

function createConcurrentApp(maxConcurrent: number) {
  const logger = pino({ level: 'silent' })
  const app = express()
  app.use(express.json())

  const v1 = Router()
  v1.use(createAuthMiddleware(new Map(keyMap)))
  v1.use(createConcurrentQueryGuard({ maxConcurrent }))

  // Slow endpoint that holds the connection for a controllable duration
  v1.get('/slow', (req, res) => {
    const delayMs = Number(req.query.delay) || 100
    setTimeout(() => res.json({ ok: true }), delayMs)
  })
  v1.get('/fast', (_req, res) => res.json({ ok: true }))

  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return app
}

// ---------------------------------------------------------------------------
// Rate limiter tests
// ---------------------------------------------------------------------------

describe('rate limiter', () => {
  it('returns 429 after exceeding per-key limit', async () => {
    const app = createRateLimitApp({ keyRpm: 3, tenantRpm: 100, ingestKeyRpm: 300 })

    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)
      assert.equal(res.status, 200)
    }

    // 4th should be rate limited
    const res = await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(res.status, 429)
    assert.equal(res.body.error.code, 'RATE_LIMITED')
  })

  it('returns Retry-After header on 429', async () => {
    const app = createRateLimitApp({ keyRpm: 1, tenantRpm: 100, ingestKeyRpm: 300 })

    await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)
    const res = await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 429)
    const retryAfter = res.headers['retry-after']
    assert.ok(retryAfter, 'should have Retry-After header')
    assert.ok(Number(retryAfter) > 0, 'Retry-After should be positive')
    assert.ok(Number(retryAfter) <= 60, 'Retry-After should be <= 60 seconds')
  })

  it('includes rate limit headers on all responses', async () => {
    const app = createRateLimitApp({ keyRpm: 10, tenantRpm: 100, ingestKeyRpm: 300 })

    const res = await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.ok(res.headers['x-ratelimit-limit'], 'should have X-RateLimit-Limit')
    assert.ok(res.headers['x-ratelimit-remaining'], 'should have X-RateLimit-Remaining')
    assert.ok(res.headers['x-ratelimit-reset'], 'should have X-RateLimit-Reset')
    assert.equal(res.headers['x-ratelimit-limit'], '10')
    assert.equal(res.headers['x-ratelimit-remaining'], '9')
  })

  it('per-tenant ceiling applies across multiple keys', async () => {
    const app = createRateLimitApp({ keyRpm: 100, tenantRpm: 3, ingestKeyRpm: 300 })

    // Key A uses 2 of the tenant's 3
    await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)
    await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)

    // Key B uses 1 more — tenant is now at 3/3
    await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_B}`)

    // Key B's next request should hit the tenant ceiling
    const res = await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_B}`)
    assert.equal(res.status, 429)
    assert.ok(res.body.error.message.includes('per-tenant'))
  })

  it('ingest endpoint has separate higher limit', async () => {
    const app = createRateLimitApp({ keyRpm: 2, tenantRpm: 100, ingestKeyRpm: 10 })

    // Exhaust the default key limit (2 requests)
    await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)
    await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)
    const readRes = await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(readRes.status, 429, 'read endpoint should be rate limited')

    // Ingest should still work (separate bucket)
    const ingestRes = await request(app).post('/v1/ingest/batch').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(ingestRes.status, 200, 'ingest endpoint should use separate bucket')
  })

  it('headers reflect the stricter of key vs tenant limit', async () => {
    const app = createRateLimitApp({ keyRpm: 5, tenantRpm: 3, ingestKeyRpm: 300 })

    const res = await request(app).get('/v1/test').set('Authorization', `Bearer ${KEY_A}`)

    // Effective limit should be min(5, 3) = 3
    assert.equal(res.headers['x-ratelimit-limit'], '3')
    assert.equal(res.headers['x-ratelimit-remaining'], '2')
  })
})

// ---------------------------------------------------------------------------
// Concurrent query guard tests
// ---------------------------------------------------------------------------

describe('concurrent query guard', () => {
  it('returns 429 when max concurrent reached', async () => {
    const logger = pino({ level: 'silent' })
    const guard = createConcurrentQueryGuard({ maxConcurrent: 2 })
    const auth = createAuthMiddleware(new Map(keyMap))

    const app = express()
    app.use(express.json())
    const v1 = Router()
    v1.use(auth)
    v1.use(guard)

    const resolvers: Array<() => void> = []

    v1.get('/hold', (_req, res) => {
      resolvers.push(() => res.json({ ok: true }))
    })
    app.use('/v1', v1)
    app.use(createErrorHandler(logger))

    // Start a real HTTP server so all requests share the same middleware state
    const server = app.listen(0)
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`

    try {
      // Fire 2 requests that hold — use fetch to avoid supertest's server-per-call behaviour
      const p1 = fetch(`${base}/v1/hold`, { headers: { authorization: `Bearer ${KEY_A}` } })
      const p2 = fetch(`${base}/v1/hold`, { headers: { authorization: `Bearer ${KEY_A}` } })

      // Wait for both to land in the route handler
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(resolvers.length, 2, 'both requests should be in-flight')

      // 3rd request should be rejected
      const r3 = await fetch(`${base}/v1/hold`, { headers: { authorization: `Bearer ${KEY_A}` } })
      assert.equal(r3.status, 429)
      const body = await r3.json() as { error: { message: string } }
      assert.ok(body.error.message.includes('concurrent'))

      // Release held requests
      for (const resolve of resolvers) resolve()
      const [r1, r2] = await Promise.all([p1, p2])
      assert.equal(r1.status, 200)
      assert.equal(r2.status, 200)
    } finally {
      server.close()
    }
  })

  it('releases slot after response finish', async () => {
    const app = createConcurrentApp(1)

    // First request completes
    const res1 = await request(app).get('/v1/fast').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(res1.status, 200)

    // Slot should be released — second request should work
    const res2 = await request(app).get('/v1/fast').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(res2.status, 200)
  })

  it('different tenants have independent limits', async () => {
    const logger = pino({ level: 'silent' })
    const multiTenantKeys = new Map([
      ['key-t1', 'tenant-1'],
      ['key-t2', 'tenant-2'],
    ])

    const app = express()
    app.use(express.json())
    const v1 = Router()
    v1.use(createAuthMiddleware(multiTenantKeys))
    v1.use(createConcurrentQueryGuard({ maxConcurrent: 1 }))
    v1.get('/slow', (_req, res) => setTimeout(() => res.json({ ok: true }), 200))
    v1.get('/fast', (_req, res) => res.json({ ok: true }))
    app.use('/v1', v1)
    app.use(createErrorHandler(logger))

    // Tenant 1 starts a slow request
    const slow = request(app).get('/v1/slow').set('Authorization', 'Bearer key-t1')
    await new Promise((r) => setTimeout(r, 20))

    // Tenant 2 should NOT be blocked
    const fast = await request(app).get('/v1/fast').set('Authorization', 'Bearer key-t2')
    assert.equal(fast.status, 200)

    await slow
  })
})

// ---------------------------------------------------------------------------
// Auth keyId tests
// ---------------------------------------------------------------------------

describe('auth keyId', () => {
  it('stores keyId in res.locals', async () => {
    const app = express()
    app.use(express.json())
    const v1 = Router()
    v1.use(createAuthMiddleware(new Map(keyMap)))
    v1.get('/check', (_req, res) => {
      res.json({ keyId: res.locals.keyId, tenantId: res.locals.tenantId })
    })
    app.use('/v1', v1)

    const res = await request(app).get('/v1/check').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(typeof res.body.keyId, 'string')
    assert.equal(res.body.keyId.length, 16)
    assert.equal(res.body.tenantId, TENANT)
  })

  it('different keys produce different keyIds', async () => {
    const app = express()
    app.use(express.json())
    const v1 = Router()
    v1.use(createAuthMiddleware(new Map(keyMap)))
    v1.get('/check', (_req, res) => res.json({ keyId: res.locals.keyId }))
    app.use('/v1', v1)

    const resA = await request(app).get('/v1/check').set('Authorization', `Bearer ${KEY_A}`)
    const resB = await request(app).get('/v1/check').set('Authorization', `Bearer ${KEY_B}`)

    assert.notEqual(resA.body.keyId, resB.body.keyId)
  })
})
