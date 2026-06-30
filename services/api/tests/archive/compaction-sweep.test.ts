import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { gunzipSync } from 'node:zlib'
import pino from 'pino'
import { ArchiveCompactionSweep } from '../../src/archive/compaction-sweep.js'
import type { S3ConnectorConfig } from '../../src/connectors/types.js'
import type { DbClient } from '../../src/db/client.js'

const logger = pino({ level: 'silent' })
const cfg = { type: 's3', bucket: 'b', region: 'us-east-1' } as unknown as S3ConnectorConfig

/** Build a partition prefix for a given UTC time (so "closed" is deterministic). */
function partitionPrefix(tenant: string, service: string, when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `tenant=${tenant}/service=${service}/date=${when.getUTCFullYear()}-${p(
    when.getUTCMonth() + 1,
  )}-${p(when.getUTCDate())}/hour=${p(when.getUTCHours())}/`
}

const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000)

/** In-memory S3: key → parsed events. putObject gunzips so we can assert content. */
function fakeStore(initial: Record<string, Record<string, unknown>[]>) {
  const store = new Map<string, unknown[]>(Object.entries(initial))
  const adapter = {
    async listObjectKeys(_c: S3ConnectorConfig, prefix: string) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
      return { keys, lastKey: keys.at(-1) }
    },
    async fetchObjectEvents(_c: S3ConnectorConfig, key: string) {
      return store.get(key) ?? []
    },
    async putObject(_c: S3ConnectorConfig, key: string, body: Buffer) {
      const events = gunzipSync(body)
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
      store.set(key, events)
    },
    async deleteObjects(_c: S3ConnectorConfig, keys: readonly string[]) {
      for (const k of keys) store.delete(k)
    },
  }
  return { store, adapter }
}

function fakeDb() {
  const repoints: { new_key: string; tenant_id: string; old_keys: string[] }[] = []
  const db = {
    async command(p: { query_params: Record<string, unknown> }) {
      repoints.push(p.query_params as never)
    },
    async query() {
      return []
    },
  } as unknown as DbClient
  return { db, repoints }
}

function build(store: ReturnType<typeof fakeStore>['adapter'], db: DbClient) {
  return new ArchiveCompactionSweep(
    {
      db,
      adapter: store,
      archiveConfig: cfg,
      settingsStore: { getAllTenantIds: () => ['t1'] },
      logger,
    },
    { minObjectsToCompact: 2, safetyLagHours: 2 },
  )
}

const compactedKeys = (store: Map<string, unknown[]>) =>
  [...store.keys()].filter((k) => k.includes('_compacted-'))

describe('ArchiveCompactionSweep.compactOnce', () => {
  it('merges + dedupes a closed partition, repoints, and deletes originals', async () => {
    const part = partitionPrefix('t1', 'svc', HOURS_AGO(25))
    const { store, adapter } = fakeStore({
      [`${part}a.log.gz`]: [
        { event_id: 'e1', m: 'a1' },
        { event_id: 'e2', m: 'a2' },
      ],
      [`${part}b.log.gz`]: [
        { event_id: 'e2', m: 'a2' },
        { event_id: 'e3', m: 'b1' },
      ], // e2 dup
    })
    const { db, repoints } = fakeDb()

    const res = await build(adapter, db).compactOnce()

    assert.equal(res.partitionsCompacted, 1)
    assert.equal(res.objectsRemoved, 2)
    // originals gone, exactly one compacted object remains.
    assert.equal(store.has(`${part}a.log.gz`), false)
    assert.equal(store.has(`${part}b.log.gz`), false)
    const compacted = compactedKeys(store)
    assert.equal(compacted.length, 1)
    // deduped union: e1, e2, e3 (e2 once).
    const ids = (store.get(compacted[0]) ?? []).map((e) => (e as { event_id: string }).event_id)
    assert.deepEqual(ids.sort(), ['e1', 'e2', 'e3'])
    // source_refs repointed from both originals to the compacted key, BEFORE delete.
    assert.equal(repoints.length, 1)
    assert.equal(repoints[0]?.new_key, compacted[0])
    assert.deepEqual(repoints[0]?.old_keys.sort(), [`${part}a.log.gz`, `${part}b.log.gz`])
  })

  it('skips a partition with fewer than minObjects', async () => {
    const part = partitionPrefix('t1', 'svc', HOURS_AGO(25))
    const { store, adapter } = fakeStore({ [`${part}only.log.gz`]: [{ event_id: 'e1' }] })
    const { db } = fakeDb()
    const res = await build(adapter, db).compactOnce()
    assert.equal(res.partitionsCompacted, 0)
    assert.equal(store.has(`${part}only.log.gz`), true)
  })

  it('skips a partition that is not yet closed (still being written)', async () => {
    const part = partitionPrefix('t1', 'svc', HOURS_AGO(0)) // current hour
    const { store, adapter } = fakeStore({
      [`${part}a.log.gz`]: [{ event_id: 'e1' }],
      [`${part}b.log.gz`]: [{ event_id: 'e2' }],
    })
    const { db } = fakeDb()
    const res = await build(adapter, db).compactOnce()
    assert.equal(res.partitionsCompacted, 0)
    assert.equal(compactedKeys(store).length, 0)
  })

  it('is idempotent — a second run does nothing and never re-compacts its output', async () => {
    const part = partitionPrefix('t1', 'svc', HOURS_AGO(25))
    const { store, adapter } = fakeStore({
      [`${part}a.log.gz`]: [{ event_id: 'e1' }],
      [`${part}b.log.gz`]: [{ event_id: 'e2' }],
    })
    const { db } = fakeDb()
    const sweep = build(adapter, db)

    await sweep.compactOnce()
    const afterFirst = compactedKeys(store)
    assert.equal(afterFirst.length, 1)

    const res2 = await sweep.compactOnce()
    assert.equal(res2.partitionsCompacted, 0, 'nothing left to compact')
    assert.deepEqual(
      compactedKeys(store),
      afterFirst,
      'compacted object untouched, not re-compacted',
    )
  })
})
