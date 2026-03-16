import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import helmet from 'helmet'
import request from 'supertest'

function createTestApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet())
  app.get('/test', (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

describe('security headers', () => {
  it('sets X-Content-Type-Options: nosniff', async () => {
    const app = createTestApp()
    const res = await request(app).get('/test')

    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  })

  it('sets X-Frame-Options header', async () => {
    const app = createTestApp()
    const res = await request(app).get('/test')

    assert.ok(res.headers['x-frame-options'], 'X-Frame-Options header should be present')
  })

  it('does not include X-Powered-By header', async () => {
    const app = createTestApp()
    const res = await request(app).get('/test')

    assert.equal(res.headers['x-powered-by'], undefined)
  })

  it('sets Content-Security-Policy header', async () => {
    const app = createTestApp()
    const res = await request(app).get('/test')

    assert.ok(res.headers['content-security-policy'], 'CSP header should be present')
  })
})
