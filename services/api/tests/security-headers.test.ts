import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import request from 'supertest'
import { ClusterClient } from '../src/pipeline/cluster-client.js'
import { createApp } from '../src/app.js'
import type { ClickHouseClient } from '../src/types.js'
import type { ClustererHealthChecker } from '../src/clients/clusterer.js'

function createTestApp() {
  const logger = pino({ level: 'silent' })
  const mockClickhouse = {
    ping: async () => ({ success: true }),
    close: async () => {},
  } as unknown as ClickHouseClient
  const mockHealth = {
    consecutiveFailures: 0,
    lastChecked: Date.now(),
    check: async () => true,
  } as unknown as ClustererHealthChecker
  const clusterClient = new ClusterClient('http://localhost:8000', 500, logger)

  return createApp({
    config: {
      port: 3000,
      clickhouseUrl: 'http://localhost:8123',
      clustererUrl: 'http://localhost:8000',
      clustererTimeoutMs: 500,
      logLevel: 'silent',
      shutdownTimeoutMs: 10_000,
      recoveryIntervalMs: 60_000,
      apiKeys: new Map([['test-key', 'tenant-test']]),
    },
    logger,
    clickhouse: mockClickhouse,
    clustererHealth: mockHealth,
    clusterClient,
  })
}

describe('security headers', () => {
  it('sets X-Content-Type-Options: nosniff', async () => {
    const app = createTestApp()
    const res = await request(app).get('/healthz')

    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  })

  it('sets X-Frame-Options header', async () => {
    const app = createTestApp()
    const res = await request(app).get('/healthz')

    assert.ok(res.headers['x-frame-options'], 'X-Frame-Options header should be present')
  })

  it('does not include X-Powered-By header', async () => {
    const app = createTestApp()
    const res = await request(app).get('/healthz')

    assert.equal(res.headers['x-powered-by'], undefined)
  })
})
