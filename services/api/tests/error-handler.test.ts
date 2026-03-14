import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import { AppError } from '../src/errors.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'

const silentLogger = pino({ level: 'silent' })

function createTestApp(routeHandler: express.RequestHandler): express.Express {
  const app = express()
  app.get('/test', routeHandler)
  app.use(createErrorHandler(silentLogger))
  return app
}

describe('error handler', () => {
  it('returns correct shape for AppError', async () => {
    const app = createTestApp((_req, _res) => {
      throw new AppError(400, 'VALIDATION_ERROR', 'bad input')
    })

    const res = await request(app).get('/test')

    assert.equal(res.status, 400)
    assert.deepEqual(res.body, {
      error: { code: 'VALIDATION_ERROR', message: 'bad input' },
    })
  })

  it('returns 500 INTERNAL_ERROR for generic Error', async () => {
    const app = createTestApp((_req, _res) => {
      throw new Error('something broke')
    })

    const res = await request(app).get('/test')

    assert.equal(res.status, 500)
    assert.deepEqual(res.body, {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    })
  })

  it('hides original message for generic errors', async () => {
    const app = createTestApp((_req, _res) => {
      throw new Error('secret database password leaked')
    })

    const res = await request(app).get('/test')

    assert.equal(res.body.error.message, 'Internal server error')
    assert.ok(!JSON.stringify(res.body).includes('secret'))
  })

  it('returns 404 for unknown routes via catch-all', async () => {
    const app = express()
    app.use((_req, _res, next) => {
      next(new AppError(404, 'NOT_FOUND', 'Route not found'))
    })
    app.use(createErrorHandler(silentLogger))

    const res = await request(app).get('/nonexistent')

    assert.equal(res.status, 404)
    assert.deepEqual(res.body, {
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    })
  })
})
