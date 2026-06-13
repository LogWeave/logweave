import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import request from 'supertest'
import { parseTrustProxy } from '../src/config.js'
import { getClientIp } from '../src/middleware/client-ip.js'
import { createIpRateLimiter } from '../src/middleware/ip-rate-limit.js'

function appReturningIp(trustProxy: boolean | number | string) {
  const app = express()
  app.set('trust proxy', trustProxy)
  app.get('/ip', (req, res) => res.json({ ip: getClientIp(req) }))
  return app
}

describe('parseTrustProxy', () => {
  it('treats unset/false/off/0 as untrusted (false)', () => {
    for (const v of [undefined, '', 'false', 'FALSE', 'off', '0']) {
      assert.equal(parseTrustProxy(v), false, `${String(v)} should be false`)
    }
  })

  it('maps true/on to a single trusted hop (1)', () => {
    assert.equal(parseTrustProxy('true'), 1)
    assert.equal(parseTrustProxy('on'), 1)
  })

  it('passes through a numeric hop count', () => {
    assert.equal(parseTrustProxy('2'), 2)
  })

  it('passes through a subnet/preset string unchanged', () => {
    assert.equal(parseTrustProxy('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8')
  })
})

describe('getClientIp', () => {
  it('ignores X-Forwarded-For when trust proxy is off', async () => {
    const app = appReturningIp(false)
    const res = await request(app).get('/ip').set('X-Forwarded-For', '1.2.3.4')
    // Socket peer (127.0.0.1 / ::ffff:127.0.0.1), never the spoofed header.
    assert.ok(res.body.ip !== '1.2.3.4', `expected socket IP, got ${res.body.ip}`)
  })

  it('honors the proxy-supplied client IP when trust proxy is on', async () => {
    const app = appReturningIp(true)
    const res = await request(app).get('/ip').set('X-Forwarded-For', '1.2.3.4')
    assert.equal(res.body.ip, '1.2.3.4')
  })
})

describe('ip rate limiter respects trust proxy', () => {
  it('spoofed X-Forwarded-For cannot dodge the limit when trust proxy is off', async () => {
    const app = express()
    app.set('trust proxy', false)
    app.use(createIpRateLimiter(2))
    app.get('/login', (_req, res) => res.json({ ok: true }))

    // All three share the same socket IP, so distinct spoofed XFF values land in
    // one bucket and the third request is limited.
    await request(app).get('/login').set('X-Forwarded-For', '10.0.0.1')
    await request(app).get('/login').set('X-Forwarded-For', '10.0.0.2')
    const res = await request(app).get('/login').set('X-Forwarded-For', '10.0.0.3')
    assert.equal(res.status, 429)
  })

  it('distinct real clients get independent buckets when trust proxy is on', async () => {
    const app = express()
    app.set('trust proxy', true)
    app.use(createIpRateLimiter(2))
    app.get('/login', (_req, res) => res.json({ ok: true }))

    // Different proxy-reported clients => different buckets => not limited.
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/login').set('X-Forwarded-For', `10.0.0.${i}`)
      assert.equal(res.status, 200)
    }
  })
})
