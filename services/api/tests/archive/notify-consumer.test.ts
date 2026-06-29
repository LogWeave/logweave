import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import { ArchiveNotifyConsumer } from '../../src/archive/notify-consumer.js'
import { ArchiveNotifyQueue } from '../../src/archive/notify-queue.js'
import type { S3Adapter } from '../../src/connectors/s3-adapter.js'
import type { S3ConnectorConfig } from '../../src/connectors/types.js'
import type { IngestDependencies } from '../../src/pipeline/ingest.js'

const logger = pino({ level: 'silent' })
const archiveConfig = { type: 's3', bucket: 'b' } as S3ConnectorConfig
// ingestBatch is only reached when an object has events; the orchestration
// tests use empty objects or throwing fetches, so it's never actually invoked.
// clusterClient.isCircuitOpen IS read each drain (the circuit-breaker skip).
const ingest = { clusterClient: { isCircuitOpen: false } } as unknown as IngestDependencies

function fakeAdapter(fetch: (key: string) => Promise<unknown[]>): S3Adapter {
  return {
    fetchObjectEvents: async (_c: S3ConnectorConfig, key: string) => fetch(key),
  } as unknown as S3Adapter
}

function makeConsumer(adapter: S3Adapter, queue: ArchiveNotifyQueue, maxAttempts = 3) {
  return new ArchiveNotifyConsumer(
    { queue, archiveConfig, adapter, logger, ingest },
    { maxAttempts },
  )
}

describe('ArchiveNotifyConsumer (orchestration)', () => {
  it('processes queued items in one drain (empty objects → no ingest)', async () => {
    const queue = new ArchiveNotifyQueue()
    queue.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' })
    queue.enqueue({ tenantId: 't', sourceRef: 'tenant=t/b' })
    const consumer = makeConsumer(
      fakeAdapter(async () => []),
      queue,
    )

    assert.equal(await consumer.drainOnce(), 2)
    assert.equal(queue.size(), 0)
  })

  it('retries a failing object, then drops it after maxAttempts', async () => {
    const queue = new ArchiveNotifyQueue()
    queue.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' })
    const consumer = makeConsumer(
      fakeAdapter(async () => {
        throw new Error('S3 down')
      }),
      queue,
      3,
    )

    // attempt 1 → re-enqueued
    assert.equal(await consumer.drainOnce(), 0)
    assert.equal(queue.size(), 1)
    // attempt 2 → re-enqueued
    assert.equal(await consumer.drainOnce(), 0)
    assert.equal(queue.size(), 1)
    // attempt 3 → dropped (reconciliation #279 is the backstop)
    assert.equal(await consumer.drainOnce(), 0)
    assert.equal(queue.size(), 0)
  })

  it('skips draining while the clusterer circuit is open (leaves items queued)', async () => {
    const queue = new ArchiveNotifyQueue()
    queue.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' })
    const consumer = new ArchiveNotifyConsumer(
      {
        queue,
        archiveConfig,
        adapter: fakeAdapter(async () => []),
        logger,
        ingest: { clusterClient: { isCircuitOpen: true } } as unknown as IngestDependencies,
      },
      {},
    )

    assert.equal(await consumer.drainOnce(), 0)
    assert.equal(queue.size(), 1, 'item stays queued for reconciliation / circuit close')
  })

  it('honours batchSize per drain', async () => {
    const queue = new ArchiveNotifyQueue()
    for (let i = 0; i < 5; i++) queue.enqueue({ tenantId: 't', sourceRef: `tenant=t/${i}` })
    const consumer = new ArchiveNotifyConsumer(
      { queue, archiveConfig, adapter: fakeAdapter(async () => []), logger, ingest },
      { batchSize: 2 },
    )

    assert.equal(await consumer.drainOnce(), 2)
    assert.equal(queue.size(), 3)
  })

  it('start/stop is idempotent and does not throw', async () => {
    const queue = new ArchiveNotifyQueue()
    const consumer = makeConsumer(
      fakeAdapter(async () => []),
      queue,
    )
    consumer.start()
    consumer.start() // second start is a no-op
    await consumer.stop()
    await consumer.stop() // second stop is a no-op
  })
})
