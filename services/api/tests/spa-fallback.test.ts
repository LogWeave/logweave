import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import request from 'supertest'
import { createApp } from '../src/app.js'
import type { ClustererHealthChecker } from '../src/clients/clusterer.js'
import type { DbClient } from '../src/db/client.js'
import { AnomalyScorer } from '../src/pipeline/anomaly-scorer.js'
import { ClusterClient } from '../src/pipeline/cluster-client.js'
import { TenantSettingsStore } from '../src/watches/tenant-settings.js'
import { WatchStore } from '../src/watches/watch-store.js'

// F7: the SPA catch-all must not shadow the API namespace. An unmatched /v1/*
// GET has to return a JSON 404, not 200 + index.html — otherwise a mistyped or
// removed API route reads as "OK" to any HTML client (browsers send
// Accept: text/html) and the routing regression is masked. These tests mount
// the real SPA fallback (which only registers when the dashboard dir exists) by
// pointing LOGWEAVE_DASHBOARD_DIR at a temp dir holding a marker index.html.

const SPA_MARKER = '<!doctype html><title>logweave-spa-test-shell</title>'

function buildApp() {
  const logger = pino({ level: 'silent' })
  const mockDb = {
    ping: async () => true,
    query: async () => [],
    insert: async () => {},
    command: async () => {},
    close: async () => {},
  } as unknown as DbClient
  const mockHealth = {
    consecutiveFailures: 0,
    lastChecked: Date.now(),
    check: async () => true,
  } as unknown as ClustererHealthChecker
  const clusterClient = new ClusterClient('http://localhost:8000', 500, logger)
  const anomalyScorer = new AnomalyScorer({ db: mockDb, logger, coldStartMs: Infinity })

  return createApp({
    config: {
      port: 3000,
      clickhouseUrl: 'http://localhost:8123',
      clustererUrl: 'http://localhost:8000',
      clustererTimeoutMs: 500,
      logLevel: 'silent',
      shutdownTimeoutMs: 10_000,
      recoveryIntervalMs: 60_000,
      recoveryLookbackHours: 24,
      apiKeys: new Map([['test-key', 'tenant-test']]),
    },
    logger,
    db: mockDb,
    clustererHealth: mockHealth,
    clusterClient,
    anomalyScorer,
    watchStore: new WatchStore(),
    settingsStore: new TenantSettingsStore(),
  }).app
}

describe('SPA fallback vs the /v1 API namespace (F7)', () => {
  let dashboardDir: string
  let prevEnv: string | undefined
  let app: ReturnType<typeof buildApp>

  before(() => {
    dashboardDir = mkdtempSync(path.join(tmpdir(), 'logweave-spa-'))
    writeFileSync(path.join(dashboardDir, 'index.html'), SPA_MARKER)
    prevEnv = process.env.LOGWEAVE_DASHBOARD_DIR
    process.env.LOGWEAVE_DASHBOARD_DIR = dashboardDir
    app = buildApp()
  })

  after(() => {
    if (prevEnv === undefined) delete process.env.LOGWEAVE_DASHBOARD_DIR
    else process.env.LOGWEAVE_DASHBOARD_DIR = prevEnv
    rmSync(dashboardDir, { recursive: true, force: true })
  })

  it('serves the SPA shell for an unknown non-API route to an HTML client', async () => {
    const res = await request(app).get('/some/client/route').set('Accept', 'text/html')
    assert.equal(res.status, 200)
    assert.match(res.text, /logweave-spa-test-shell/, 'should serve the SPA index.html')
  })

  it('returns a JSON 404 (not the SPA shell) for an unknown /v1 route to an HTML client', async () => {
    const res = await request(app)
      .get('/v1/this-route-does-not-exist')
      .set('Authorization', 'Bearer test-key') // authenticated, so we pass the v1 auth gate
      .set('Accept', 'text/html')

    assert.equal(res.status, 404, 'unknown /v1 route must 404, not serve the SPA')
    assert.match(res.headers['content-type'] ?? '', /application\/json/)
    assert.doesNotMatch(res.text ?? '', /logweave-spa-test-shell/, 'must NOT be the SPA shell')
  })

  it('does not serve the SPA shell for the bare /v1 path either', async () => {
    const res = await request(app)
      .get('/v1')
      .set('Authorization', 'Bearer test-key')
      .set('Accept', 'text/html')
    assert.equal(res.status, 404)
    assert.doesNotMatch(res.text ?? '', /logweave-spa-test-shell/)
  })
})
