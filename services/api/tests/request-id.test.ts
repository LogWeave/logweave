import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import request from 'supertest'
import { requestIdMiddleware } from '../src/middleware/request-id.js'

function createTestApp(): express.Express {
  const app = express()
  app.use(requestIdMiddleware)
  app.get('/test', (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

describe('request-id middleware', () => {
  it('echoes provided x-request-id header', async () => {
    const app = createTestApp()
    const res = await request(app).get('/test').set('x-request-id', 'my-req-123')

    assert.equal(res.headers['x-request-id'], 'my-req-123')
    assert.equal(res.status, 200)
  })

  it('generates UUID when x-request-id is absent', async () => {
    const app = createTestApp()
    const res = await request(app).get('/test')

    const id = res.headers['x-request-id'] as string
    assert.ok(id, 'x-request-id header should be set')
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('generates UUID for invalid x-request-id', async () => {
    const app = createTestApp()
    const res = await request(app).get('/test').set('x-request-id', '<script>alert("xss")</script>')

    const id = res.headers['x-request-id'] as string
    assert.ok(id)
    assert.match(id, /^[0-9a-f]{8}-/)
  })
})
