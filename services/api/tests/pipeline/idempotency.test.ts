import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { AnomalyScorer } from '../../src/pipeline/anomaly-scorer.js'
import type { ClusterClient, ClusterResult } from '../../src/pipeline/cluster-client.js'
import {
  clearIdempotencyCache,
  computeBatchKey,
  extractEventId,
} from '../../src/pipeline/idempotency.js'
import { ingestBatch } from '../../src/pipeline/ingest.js'

const logger = pino({ level: 'silent' })
const TENANT = 'tenant-idem'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function createDb(): { db: DbClient; inserts: unknown[][] } {
  const inserts: unknown[][] = []
  const db = {
    insert: async (params: { table?: string; values: unknown[] }) => {
      if (params.table === 'logweave.event_tags') return
      inserts.push(params.values)
    },
    query: async () => [],
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, inserts }
}

function clusterClient(count: number): ClusterClient {
  const results: ClusterResult[] = Array.from({ length: count }, () => ({
    templateId: 't1',
    templateText: 'hello <*>',
    isNewTemplate: false,
  }))
  return { cluster: async () => results } as unknown as ClusterClient
}

function deps(db: DbClient, count: number) {
  return {
    clusterClient: clusterClient(count),
    db,
    logger,
    anomalyScorer: new AnomalyScorer({ db, logger, coldStartMs: Infinity }),
  }
}

describe('idempotency helpers', () => {
  it('extractEventId returns only well-formed UUIDs, else undefined', () => {
    const uuid = '019f0806-453e-702f-a68a-a1b4cf159dc3'
    assert.equal(extractEventId({ event_id: uuid }), uuid)
    assert.equal(extractEventId({ event_id: 'abc' }), undefined, 'non-UUID rejected')
    assert.equal(extractEventId({ event_id: '' }), undefined)
    assert.equal(extractEventId({ event_id: 123 }), undefined)
    assert.equal(extractEventId({}), undefined)
    assert.equal(extractEventId('nope'), undefined)
  })

  it('computeBatchKey is deterministic and order-independent', () => {
    assert.equal(computeBatchKey(['a', 'b', 'c']), computeBatchKey(['c', 'a', 'b']))
    assert.notEqual(computeBatchKey(['a', 'b']), computeBatchKey(['a', 'b', 'c']))
  })
})

describe('ingestBatch — event_id + idempotency', () => {
  beforeEach(() => clearIdempotencyCache())

  it('generates a UUIDv7 fallback when an event has no event_id', async () => {
    const { db, inserts } = createDb()
    await ingestBatch(deps(db, 1), TENANT, [{ message: 'hi', service: 'api' }], {})

    const rows = inserts[0] as Array<{ id: string; event_id: string }>
    assert.match(rows[0]?.event_id ?? '', UUID_RE, 'event_id should be a UUIDv7')
    assert.notEqual(rows[0]?.event_id, rows[0]?.id, 'event_id is distinct from server id')
  })

  it('falls back to a generated UUIDv7 when the client event_id is not a UUID', async () => {
    // Guards a regression: a non-UUID event_id written to the UUID column would
    // fail the insert and poison the batch. It must be replaced, not passed through.
    const { db, inserts } = createDb()
    await ingestBatch(
      deps(db, 1),
      TENANT,
      [{ message: 'hi', service: 'api', event_id: 'not-a-uuid' }],
      {},
    )

    const rows = inserts[0] as Array<{ event_id: string }>
    assert.match(rows[0]?.event_id ?? '', UUID_RE, 'bad event_id replaced with a UUIDv7')
    assert.notEqual(rows[0]?.event_id, 'not-a-uuid')
  })

  it('preserves a source-assigned event_id on the row', async () => {
    const { db, inserts } = createDb()
    const eventId = '019f0806-453e-702f-a68a-a1b4cf159dc3'
    await ingestBatch(
      deps(db, 1),
      TENANT,
      [{ message: 'hi', service: 'api', event_id: eventId }],
      {},
    )

    const rows = inserts[0] as Array<{ event_id: string }>
    assert.equal(rows[0]?.event_id, eventId)
  })

  it('short-circuits a re-submitted batch with the same Idempotency-Key (single insert)', async () => {
    const { db, inserts } = createDb()
    const events = [{ message: 'hi', service: 'api' }]
    const opts = { idempotencyKey: 'batch-key-1' }

    const first = await ingestBatch(deps(db, 1), TENANT, events, opts)
    const second = await ingestBatch(deps(db, 1), TENANT, events, opts)

    assert.equal(inserts.length, 1, 'duplicate batch must insert only once')
    assert.deepEqual(second, first, 'replay returns the original result')
  })

  it('short-circuits a replay by source event_id hash when no header is given', async () => {
    const { db, inserts } = createDb()
    const events = [
      { message: 'a', service: 'api', event_id: '019f0806-0000-7000-8000-000000000001' },
      { message: 'b', service: 'api', event_id: '019f0806-0000-7000-8000-000000000002' },
    ]
    await ingestBatch(deps(db, 2), TENANT, events, {})
    await ingestBatch(deps(db, 2), TENANT, events, {})

    assert.equal(inserts.length, 1, 'same source event_ids must dedupe without a header')
  })

  it('does not dedupe batches that carry no key and no source event_ids', async () => {
    const { db, inserts } = createDb()
    const events = [{ message: 'hi', service: 'api' }]
    await ingestBatch(deps(db, 1), TENANT, events, {})
    await ingestBatch(deps(db, 1), TENANT, events, {})

    assert.equal(inserts.length, 2, 'no stable identity → both processed')
  })
})
