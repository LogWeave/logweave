import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import { ArchiveNotifyQueue } from '../../src/archive/notify-queue.js'
import { ArchiveReconcileSweep } from '../../src/archive/reconcile-sweep.js'
import type { S3ConnectorConfig } from '../../src/connectors/types.js'
import type { DbClient } from '../../src/db/client.js'

const logger = pino({ level: 'silent' })
const archiveConfig = {
  type: 's3',
  bucket: 'b',
  region: 'us-east-1',
} as unknown as S3ConnectorConfig

/** Fake DbClient: answers the cursor read + source_ref membership by query text. */
function fakeDb(opts: { cursor?: string; existing?: string[] }): {
  db: DbClient
  cursorWrites: string[]
} {
  const cursorWrites: string[] = []
  const db = {
    async query(params: { query: string }) {
      if (params.query.includes('archive_reconcile_cursor')) {
        return opts.cursor ? [{ last_key: opts.cursor }] : []
      }
      if (params.query.includes('source_ref IN')) {
        return (opts.existing ?? []).map((s) => ({ source_ref: s }))
      }
      return []
    },
    async insert(params: { values: { last_key: string }[] }) {
      cursorWrites.push(params.values[0]?.last_key ?? '')
    },
  } as unknown as DbClient
  return { db, cursorWrites }
}

function fakeAdapter(keys: string[]) {
  return {
    async listObjectKeys(
      _c: S3ConnectorConfig,
      _p: string,
      startAfter: string | undefined,
      maxKeys: number,
    ) {
      const after = startAfter ? keys.filter((k) => k > startAfter) : keys
      const page = after.slice(0, maxKeys)
      return { keys: page, lastKey: page.at(-1) }
    },
  }
}

function build(opts: {
  keys: string[]
  cursor?: string
  existing?: string[]
  behindThreshold?: number
}) {
  const { db, cursorWrites } = fakeDb({ cursor: opts.cursor, existing: opts.existing })
  const queue = new ArchiveNotifyQueue()
  const emitted: { event: string; fields?: Record<string, unknown> }[] = []
  const sweep = new ArchiveReconcileSweep(
    {
      db,
      adapter: fakeAdapter(opts.keys),
      archiveConfig,
      queue,
      settingsStore: { getAllTenantIds: () => ['t1'] },
      logger,
      emitter: { emit: (i) => emitted.push({ event: i.event, fields: i.fields }) },
    },
    { behindThreshold: opts.behindThreshold ?? 100 },
  )
  return { sweep, queue, cursorWrites, emitted }
}

const enqueuedRefs = (q: ArchiveNotifyQueue): string[] => q.dequeue(1000).map((i) => i.sourceRef)

describe('ArchiveReconcileSweep.reconcileOnce', () => {
  it('enqueues missing objects and not present ones', async () => {
    const { sweep, queue } = build({
      keys: ['tenant=t1/a', 'tenant=t1/b', 'tenant=t1/c', 'tenant=t1/d'],
      existing: ['tenant=t1/a', 'tenant=t1/b'],
    })
    const res = await sweep.reconcileOnce()
    assert.equal(res.missingEnqueued, 2)
    assert.deepEqual(enqueuedRefs(queue), ['tenant=t1/c', 'tenant=t1/d'])
  })

  it('advances the watermark to the last key when nothing is missing', async () => {
    const { sweep, queue, cursorWrites } = build({
      keys: ['tenant=t1/a', 'tenant=t1/b'],
      existing: ['tenant=t1/a', 'tenant=t1/b'],
    })
    await sweep.reconcileOnce()
    assert.equal(enqueuedRefs(queue).length, 0)
    assert.deepEqual(cursorWrites, ['tenant=t1/b'])
  })

  it('advances the watermark only up to the key before the earliest missing one', async () => {
    const { sweep, cursorWrites } = build({
      keys: ['tenant=t1/a', 'tenant=t1/b', 'tenant=t1/c', 'tenant=t1/d'],
      existing: ['tenant=t1/a', 'tenant=t1/b'], // c missing → watermark stops at b
    })
    await sweep.reconcileOnce()
    assert.deepEqual(cursorWrites, ['tenant=t1/b'])
  })

  it('does not advance the watermark when the first listed key is missing', async () => {
    const { sweep, cursorWrites } = build({
      keys: ['tenant=t1/a', 'tenant=t1/b'],
      existing: [], // a (first) missing → no contiguous prefix to confirm
    })
    await sweep.reconcileOnce()
    assert.deepEqual(cursorWrites, []) // watermark untouched → a stays in window
  })

  it('emits archive.reconcile_behind when missing exceeds the threshold', async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `tenant=t1/k${i}`)
    const { sweep, emitted } = build({ keys, existing: [], behindThreshold: 3 })
    await sweep.reconcileOnce()
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]?.event, 'archive.reconcile_behind')
    assert.equal(emitted[0]?.fields?.missing, 5)
  })

  it('is a no-op when the tenant has no archived objects', async () => {
    const { sweep, queue, cursorWrites, emitted } = build({ keys: [], existing: [] })
    const res = await sweep.reconcileOnce()
    assert.equal(res.objectsListed, 0)
    assert.equal(enqueuedRefs(queue).length, 0)
    assert.deepEqual(cursorWrites, [])
    assert.equal(emitted.length, 0)
  })
})
