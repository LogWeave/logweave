import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../src/db/client.js'
import type { IngestDeps } from '../src/lib/ingest-deps.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { AnomalyScorer } from '../src/pipeline/anomaly-scorer.js'
import { ClusterClient } from '../src/pipeline/cluster-client.js'
import { otlpIngestRoutes } from '../src/routes/ingest-otlp.js'
import { TenantSettingsStore } from '../src/watches/tenant-settings.js'

const API_KEY = 'test-key'
const TENANT = 'tenant-otlp'

async function createApp(opts: {
  clusterResults: Array<{ template_id: string; template_text: string; is_new: boolean }>
  minIngestLevel?: string
}) {
  const logger = pino({ level: 'silent' })
  const db = {
    insert: async () => {},
    query: async () => [],
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient

  const fetchFn: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ results: opts.clusterResults }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  const clusterClient = new ClusterClient('http://localhost:8000', 500, logger, fetchFn)
  const anomalyScorer = new AnomalyScorer({ db, logger, coldStartMs: Infinity })

  const settingsStore = new TenantSettingsStore({ logger })
  if (opts.minIngestLevel) {
    await settingsStore.set(TENANT, { minIngestLevel: opts.minIngestLevel })
  }

  const deps = {
    clusterClient,
    db,
    logger,
    anomalyScorer,
    settingsStore,
  } as unknown as IngestDeps

  const app = express()
  const auth = createAuthMiddleware(new Map([[API_KEY, TENANT]]))
  app.use('/v1/otlp', auth, otlpIngestRoutes(deps))
  app.use(createErrorHandler(logger))
  return app
}

function otlpBody(records: Array<{ body: string; severityText?: string }>) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeLogs: [
          {
            logRecords: records.map((r) => ({
              timeUnixNano: '1700000000000000000',
              severityText: r.severityText ?? 'INFO',
              body: { stringValue: r.body },
            })),
          },
        ],
      },
    ],
  }
}

describe('POST /v1/otlp/logs', () => {
  // Bug #170 regression: rejection message used to say "could not be parsed",
  // but `rejected` counts any drop reason (level filter, throttle, dedupe).
  it('uses neutral "could not be ingested" wording when level filter drops events', async () => {
    const app = await createApp({
      clusterResults: [{ template_id: 'tpl-1', template_text: 'hi <*>', is_new: false }],
      minIngestLevel: 'WARN',
    })

    // 2 records: one INFO (will be dropped by level filter), one ERROR (kept).
    const res = await request(app)
      .post('/v1/otlp/logs')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Content-Type', 'application/json')
      .send(
        otlpBody([
          { body: 'hi info', severityText: 'INFO' },
          { body: 'hi error', severityText: 'ERROR' },
        ]),
      )

    assert.equal(res.status, 200)
    assert.equal(res.body.partialSuccess.rejectedLogRecords, 1)
    const msg = res.body.partialSuccess.errorMessage as string
    assert.ok(msg.includes('could not be ingested'), `expected neutral wording, got: ${msg}`)
    assert.ok(!msg.toLowerCase().includes('parsed'), 'must not say "parsed"')
  })

  it('returns empty errorMessage when nothing rejected', async () => {
    const app = await createApp({
      clusterResults: [{ template_id: 'tpl-1', template_text: 'hello <*>', is_new: true }],
    })

    const res = await request(app)
      .post('/v1/otlp/logs')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Content-Type', 'application/json')
      .send(otlpBody([{ body: 'hello world' }]))

    assert.equal(res.status, 200)
    assert.equal(res.body.partialSuccess.rejectedLogRecords, 0)
    assert.equal(res.body.partialSuccess.errorMessage, '')
  })
})
