import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../src/db/client.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { AnomalyScorer } from '../src/pipeline/anomaly-scorer.js'
import { ClusterClient } from '../src/pipeline/cluster-client.js'
import { ingestRoutes } from '../src/routes/ingest.js'
import type { LogMetadataRow } from '../src/types.js'

const API_KEY = 'test-key'
const TENANT_ID = 'tenant-test'
const keyMap = new Map([[API_KEY, TENANT_ID]])

const CLUSTER_RESPONSE = {
  results: [{ template_id: 'tpl-1', template_text: 'User <*> logged in', is_new: true }],
}

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
}

function createTestApp(options?: { fetchFn?: typeof globalThis.fetch; insertError?: Error }) {
  const logger = pino({ level: 'silent' })
  const insertedRows: LogMetadataRow[][] = []

  const mockDb = {
    insert: async (params: { values: LogMetadataRow[] }) => {
      if (options?.insertError) throw options.insertError
      insertedRows.push(params.values)
    },
    query: async () => [],
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient

  const fetchFn = options?.fetchFn ?? mockFetch(200, CLUSTER_RESPONSE)
  const clusterClient = new ClusterClient('http://localhost:8000', 500, logger, fetchFn)

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  const auth = createAuthMiddleware(keyMap)
  const anomalyScorer = new AnomalyScorer({ db: mockDb, logger, coldStartMs: Infinity })
  app.use(
    '/v1',
    auth,
    ingestRoutes({
      clusterClient,
      db: mockDb,
      logger,
      anomalyScorer,
    }),
  )

  app.use(createErrorHandler(logger))

  return { app, insertedRows, clusterClient }
}

function validEvent(overrides?: Record<string, unknown>) {
  return {
    message: 'User alice logged in',
    level: 'info',
    service: 'auth-api',
    environment: 'production',
    timestamp: '2026-03-14T12:00:00.000Z',
    ...overrides,
  }
}

describe('POST /v1/ingest/batch', () => {
  it('ingests valid events and returns success counts', async () => {
    const multiResponse = {
      results: [
        { template_id: 'tpl-1', template_text: 'User <*> logged in', is_new: true },
        { template_id: 'tpl-1', template_text: 'User <*> logged in', is_new: false },
      ],
    }
    const { app, insertedRows } = createTestApp({ fetchFn: mockFetch(200, multiResponse) })

    const res = await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: [validEvent(), validEvent({ message: 'User bob logged in' })] })

    assert.equal(res.status, 200)
    assert.equal(res.body.accepted, 2)
    assert.equal(res.body.clustered, 2)
    assert.equal(res.body.unclustered, 0)
    assert.equal(res.body.new_templates, 1)
    assert.equal(insertedRows.length, 1)
    assert.equal(insertedRows[0]?.length, 2)
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/ingest/batch')
      .send({ events: [validEvent()] })

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'UNAUTHORIZED')
  })

  it('returns 400 for malformed payload (events not an array)', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: 'not-an-array' })

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('returns 413 for oversized body', async () => {
    const { app } = createTestApp()
    // Generate a payload > 1MB
    const largeEvent = { message: 'x'.repeat(10_000), level: 'info' }
    const events = Array.from({ length: 110 }, () => largeEvent) // ~1.1MB
    const res = await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events })

    assert.equal(res.status, 413)
  })

  it('returns 400 for empty events array', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: [] })

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  })

  it('skips bad events without rejecting the batch', async () => {
    const multiResponse = {
      results: [{ template_id: 'tpl-1', template_text: 'template', is_new: false }],
    }
    const { app } = createTestApp({ fetchFn: mockFetch(200, multiResponse) })

    const res = await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({
        events: ['not-an-object', validEvent(), 42],
      })

    assert.equal(res.status, 200)
    assert.equal(res.body.accepted, 1)
  })

  it('handles clusterer timeout gracefully (template_id=0)', async () => {
    const abortError = new DOMException('timeout', 'AbortError')
    const failFetch: typeof globalThis.fetch = async () => {
      throw abortError
    }
    const { app, insertedRows } = createTestApp({ fetchFn: failFetch })

    const res = await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: [validEvent()] })

    assert.equal(res.status, 200)
    assert.equal(res.body.unclustered, 1)
    assert.equal(res.body.clustered, 0)

    const row = insertedRows[0]?.[0]
    assert.equal(row?.template_id, '0')
    assert.equal(row?.template_text, '[unclustered]')
    assert.ok(
      row?.pre_processed_message,
      'pre_processed_message should be populated for unclustered',
    )
  })

  it('sets correct tenant_id on inserted rows', async () => {
    const { app, insertedRows } = createTestApp()

    await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: [validEvent()] })

    const row = insertedRows[0]?.[0]
    assert.equal(row?.tenant_id, TENANT_ID)
  })

  it('uppercases level for ClickHouse MV compatibility', async () => {
    const { app, insertedRows } = createTestApp()

    await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: [validEvent({ level: 'error' })] })

    const row = insertedRows[0]?.[0]
    assert.equal(row?.level, 'ERROR')
  })

  it('extracts timestamp from event, falls back to ingest time', async () => {
    const multiResponse = {
      results: [
        { template_id: 'tpl-1', template_text: 'template', is_new: false },
        { template_id: 'tpl-1', template_text: 'template', is_new: false },
      ],
    }
    const { app, insertedRows } = createTestApp({ fetchFn: mockFetch(200, multiResponse) })

    await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({
        events: [
          validEvent({ timestamp: '2026-01-01T00:00:00Z' }),
          validEvent({ timestamp: undefined }),
        ],
      })

    const rows = insertedRows[0]
    assert.ok(rows, 'expected a batch to have been inserted')
    assert.equal(rows[0]?.timestamp, '2026-01-01T00:00:00Z')
    // Second row should have ingest time (ISO string starting with current year)
    assert.ok(rows[1]?.timestamp.startsWith('20'), 'Expected ingest time as fallback')
  })

  it('returns 500 with safe error when ClickHouse INSERT fails', async () => {
    const { app } = createTestApp({
      insertError: new Error('Connection refused: clickhouse:8123'),
    })

    const res = await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: [validEvent()] })

    assert.equal(res.status, 500)
    assert.equal(res.body.error.code, 'INTERNAL_ERROR')
    assert.equal(res.body.error.message, 'Internal server error')
    // Must not leak internal details
    assert.ok(
      !JSON.stringify(res.body).includes('Connection refused'),
      'Error response must not leak internal details',
    )
  })

  it('sets source_type=transport and preprocessing_version', async () => {
    const { app, insertedRows } = createTestApp()

    await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: [validEvent()] })

    const row = insertedRows[0]?.[0]
    assert.equal(row?.source_type, 'transport')
    assert.equal(row?.source_ref, '')
    assert.equal(row?.preprocessing_version, 1)
  })

  it('accepts custom source_type and source_ref', async () => {
    const { app, insertedRows } = createTestApp()

    await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({
        events: [validEvent()],
        source_type: 's3',
        source_ref: 's3://bucket/logs/2026/03/21/14/file.jsonl.gz',
      })

    const row = insertedRows[0]?.[0]
    assert.equal(row?.source_type, 's3')
    assert.equal(row?.source_ref, 's3://bucket/logs/2026/03/21/14/file.jsonl.gz')
  })

  it('defaults source_type and source_ref when not provided', async () => {
    const { app, insertedRows } = createTestApp()

    await request(app)
      .post('/v1/ingest/batch')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ events: [validEvent()] })

    const row = insertedRows[0]?.[0]
    assert.equal(row?.source_type, 'transport')
    assert.equal(row?.source_ref, '')
  })
})
