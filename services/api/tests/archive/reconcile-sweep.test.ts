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

/**
 * Fake DbClient: answers the cursor read + source_ref membership by query text.
 * Persists the written cursor (so the `newCursor !== cursor` dedup is exercised)
 * and supports a mutable `existing` (a function) for multi-sweep scenarios.
 */
function fakeDb(opts: { cursor?: string; existing?: string[] | (() => string[]) }): {
  db: DbClient
  cursorWrites: string[]
} {
  const cursorWrites: string[] = []
  let current = opts.cursor ?? ''
  const existingOf = (): string[] =>
    typeof opts.existing === 'function' ? opts.existing() : (opts.existing ?? [])
  const db = {
    async query(params: { query: string }) {
      if (params.query.includes('archive_reconcile_cursor')) {
        return current ? [{ last_key: current }] : []
      }
      if (params.query.includes('source_ref IN')) {
        return existingOf().map((s) => ({ source_ref: s }))
      }
      return []
    },
    async insert(params: { values: { last_key: string }[] }) {
      current = params.values[0]?.last_key ?? ''
      cursorWrites.push(current)
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
  quarantineThreshold?: number
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
    { behindThreshold: opts.behindThreshold ?? 100, quarantineThreshold: opts.quarantineThreshold },
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

  it('sweeps a forward-only tenant present only in the api-key store (#287)', async () => {
    // The tenant has no settings row (getAllTenantIds → []) but does have an API
    // key — the exact "forward-only" case #287 must cover. Without the union its
    // forwarded objects would never be listed and stay unqueryable.
    const { db } = fakeDb({ existing: [] })
    const queue = new ArchiveNotifyQueue()
    const sweep = new ArchiveReconcileSweep({
      db,
      adapter: fakeAdapter(['tenant=t1/a', 'tenant=t1/b']),
      archiveConfig,
      queue,
      settingsStore: { getAllTenantIds: () => [] },
      apiKeyStore: { getAllTenantIds: () => ['t1'] },
      logger,
      emitter: { emit: () => {} },
    })
    const res = await sweep.reconcileOnce()
    assert.equal(res.tenantsProcessed, 1)
    assert.deepEqual(enqueuedRefs(queue), ['tenant=t1/a', 'tenant=t1/b'])
  })

  it('dedupes a tenant present in both settings and the api-key store (#287)', async () => {
    const { db } = fakeDb({ existing: [] })
    const queue = new ArchiveNotifyQueue()
    const sweep = new ArchiveReconcileSweep({
      db,
      adapter: fakeAdapter(['tenant=t1/a']),
      archiveConfig,
      queue,
      settingsStore: { getAllTenantIds: () => ['t1'] },
      apiKeyStore: { getAllTenantIds: () => ['t1'] },
      logger,
      emitter: { emit: () => {} },
    })
    const res = await sweep.reconcileOnce()
    // Unioned via a Set — the shared tenant is processed once, not twice.
    assert.equal(res.tenantsProcessed, 1)
    assert.deepEqual(enqueuedRefs(queue), ['tenant=t1/a'])
  })

  it('never enqueues compacted objects (#284) even when they look missing', async () => {
    const { sweep, queue } = build({
      keys: [
        'tenant=t1/svc/date=2026-06-30/hour=00/obj-a.log.gz',
        'tenant=t1/svc/date=2026-06-30/hour=00/_compacted-deadbeef.log.gz',
      ],
      existing: [], // both absent from log_metadata
    })
    await sweep.reconcileOnce()
    const refs = enqueuedRefs(queue)
    assert.ok(
      !refs.some((r) => r.includes('_compacted-')),
      'a compacted object must never be reconciled (its rows are already repointed)',
    )
    assert.deepEqual(refs, ['tenant=t1/svc/date=2026-06-30/hour=00/obj-a.log.gz'])
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

  it('quarantines a persistently-missing head key so the watermark can advance', async () => {
    // a is never ingested (poison); b, c are present. With threshold 2, the
    // second sweep gives up on a and the watermark jumps to the last key.
    const { sweep, cursorWrites, emitted } = build({
      keys: ['tenant=t1/a', 'tenant=t1/b', 'tenant=t1/c'],
      existing: ['tenant=t1/b', 'tenant=t1/c'],
      quarantineThreshold: 2,
    })

    await sweep.reconcileOnce() // sweep 1: a missing (count 1) blocks → no advance
    assert.deepEqual(cursorWrites, [])
    assert.equal(emitted.length, 0)

    await sweep.reconcileOnce() // sweep 2: a hits threshold → quarantined
    assert.deepEqual(cursorWrites, ['tenant=t1/c'])
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]?.event, 'archive.object_quarantined')
    assert.equal(emitted[0]?.fields?.source_ref, 'tenant=t1/a')
  })

  it('resets the miss count when a previously-missing key lands', async () => {
    // a missing on sweep 1, present after → never quarantined; the watermark
    // advances once and the dedup suppresses a redundant rewrite.
    let landed = false
    const { db, cursorWrites } = fakeDb({ existing: () => (landed ? ['tenant=t1/a'] : []) })
    const emitted: { event: string }[] = []
    const sweep = new ArchiveReconcileSweep(
      {
        db,
        adapter: fakeAdapter(['tenant=t1/a']),
        archiveConfig,
        queue: new ArchiveNotifyQueue(),
        settingsStore: { getAllTenantIds: () => ['t1'] },
        logger,
        emitter: { emit: (i) => emitted.push({ event: i.event }) },
      },
      { quarantineThreshold: 2 },
    )

    await sweep.reconcileOnce() // a missing (count 1)
    landed = true
    await sweep.reconcileOnce() // a present → count cleared, watermark advances to a
    await sweep.reconcileOnce() // still present — would quarantine if count had survived

    assert.equal(emitted.length, 0, 'a transient miss must never quarantine')
    assert.deepEqual(cursorWrites, ['tenant=t1/a'])
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
