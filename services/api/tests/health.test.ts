import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import express from 'express'
import request from 'supertest'
import type { ClustererHealthChecker } from '../src/clients/clusterer.js'
import { _resetReadyCache, healthRoutes } from '../src/routes/health.js'
import type { ClickHouseClient } from '../src/types.js'

function createMockClickhouse(pingResult: boolean): ClickHouseClient {
  return {
    ping: async () => ({ success: pingResult }),
    close: async () => {},
  } as unknown as ClickHouseClient
}

function createMockClustererHealth(failures = 0): ClustererHealthChecker {
  return {
    consecutiveFailures: failures,
    lastChecked: Date.now(),
    url: 'http://localhost:8000',
    timeoutMs: 500,
    check: async () => failures === 0,
  } as unknown as ClustererHealthChecker
}

function createTestApp(pingResult: boolean, clustererFailures = 0): express.Express {
  const app = express()
  app.use(
    healthRoutes({
      clickhouse: createMockClickhouse(pingResult),
      clustererHealth: createMockClustererHealth(clustererFailures),
    }),
  )
  return app
}

describe('health routes', () => {
  beforeEach(() => {
    _resetReadyCache()
  })

  it('GET /healthz returns 200', async () => {
    const app = createTestApp(true)
    const res = await request(app).get('/healthz')

    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { status: 'ok' })
  })

  it('GET /readyz returns 200 when ClickHouse is reachable', async () => {
    const app = createTestApp(true)
    const res = await request(app).get('/readyz')

    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'ready')
    assert.equal(res.body.clickhouse, 'ok')
  })

  it('GET /readyz returns 503 when ClickHouse is unreachable', async () => {
    const app = createTestApp(false)
    const res = await request(app).get('/readyz')

    assert.equal(res.status, 503)
    assert.equal(res.body.status, 'not_ready')
    assert.equal(res.body.clickhouse, 'error')
  })

  it('GET /readyz reports clusterer consecutiveFailures', async () => {
    const app = createTestApp(true, 3)
    const res = await request(app).get('/readyz')

    assert.equal(res.status, 200) // clusterer down does NOT cause 503
    assert.equal(res.body.clusterer.status, 'degraded')
    assert.equal(res.body.clusterer.consecutiveFailures, 3)
  })
})
