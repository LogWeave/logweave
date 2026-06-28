import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import { ArchiveNotifyQueue } from '../src/archive/notify-queue.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { ingestNotifyRoutes } from '../src/routes/ingest-notify.js'

const SECRET = 'internal-secret-xyz'

function createTestApp(opts?: { secret?: string }) {
  const logger = pino({ level: 'silent' })
  const queue = new ArchiveNotifyQueue()
  // Distinguish "omitted" (use SECRET) from "explicitly undefined" (no secret).
  const secret = opts && 'secret' in opts ? opts.secret : SECRET
  const app = express()
  app.use(express.json())
  app.use(ingestNotifyRoutes({ queue, logger, internalSecret: secret }))
  app.use(createErrorHandler(logger))
  return { app, queue }
}

const envelope = (over?: Record<string, unknown>) => ({
  tenant_id: 'tenant-a',
  source_ref: 'tenant=tenant-a/service=payments/date=2026-06-29/hour=00/obj.log.gz',
  source_type: 's3',
  ...over,
})

describe('POST /v1/ingest/notify', () => {
  it('fails closed (503) when no internal secret is configured', async () => {
    const { app } = createTestApp({ secret: undefined })
    const res = await request(app).post('/v1/ingest/notify').send(envelope())
    assert.equal(res.status, 503)
  })

  it('401 when the internal secret header is missing', async () => {
    const { app, queue } = createTestApp()
    const res = await request(app).post('/v1/ingest/notify').send(envelope())
    assert.equal(res.status, 401)
    assert.equal(queue.size(), 0)
  })

  it('403 when the internal secret is wrong', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/ingest/notify')
      .set('X-Internal-Secret', 'nope')
      .send(envelope())
    assert.equal(res.status, 403)
  })

  it('202 enqueues a single envelope with the correct secret', async () => {
    const { app, queue } = createTestApp()
    const res = await request(app)
      .post('/v1/ingest/notify')
      .set('X-Internal-Secret', SECRET)
      .send(envelope())
    assert.equal(res.status, 202)
    assert.deepEqual(res.body, { received: 1, enqueued: 1 })
    assert.equal(queue.size(), 1)
    assert.deepEqual(queue.dequeue(1), [
      {
        tenantId: 'tenant-a',
        sourceRef: 'tenant=tenant-a/service=payments/date=2026-06-29/hour=00/obj.log.gz',
        service: undefined,
      },
    ])
  })

  it('202 enqueues a batch and is idempotent on source_ref within it', async () => {
    const { app, queue } = createTestApp()
    const dup = envelope()
    const res = await request(app)
      .post('/v1/ingest/notify')
      .set('X-Internal-Secret', SECRET)
      .send([
        dup,
        dup,
        envelope({
          source_ref: 'tenant=tenant-a/service=payments/date=2026-06-29/hour=01/x.log.gz',
        }),
      ])
    assert.equal(res.status, 202)
    // 3 received, but the duplicate source_ref collapses → 2 enqueued.
    assert.deepEqual(res.body, { received: 3, enqueued: 2 })
    assert.equal(queue.size(), 2)
  })

  it('400 when source_ref is outside the envelope tenant prefix (cross-tenant)', async () => {
    const { app, queue } = createTestApp()
    const res = await request(app)
      .post('/v1/ingest/notify')
      .set('X-Internal-Secret', SECRET)
      .send(
        envelope({
          tenant_id: 'tenant-a',
          source_ref: 'tenant=victim/service=payments/date=2026-06-29/hour=00/secret.log.gz',
        }),
      )
    assert.equal(res.status, 400)
    assert.equal(queue.size(), 0)
  })

  it('400 when source_ref contains a path-traversal marker', async () => {
    const { app, queue } = createTestApp()
    const res = await request(app)
      .post('/v1/ingest/notify')
      .set('X-Internal-Secret', SECRET)
      // Starts with the tenant prefix but escapes it via '..'.
      .send(envelope({ source_ref: 'tenant=tenant-a/../tenant=victim/x.log.gz' }))
    assert.equal(res.status, 400)
    assert.equal(queue.size(), 0)
  })

  it('400 on an unknown source_type', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/ingest/notify')
      .set('X-Internal-Secret', SECRET)
      .send(envelope({ source_type: 'azure' }))
    assert.equal(res.status, 400)
  })
})
