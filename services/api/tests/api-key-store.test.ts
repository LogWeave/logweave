import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import {
  ApiKeyLimitError,
  ApiKeyStore,
  ApiKeyStoreNotReadyError,
} from '../src/auth/api-key-store.js'
import type { DbClient } from '../src/db/client.js'

const silentLogger = pino({ level: 'silent' })
const SECRET = 'integration-test-hmac-secret-32-bytes-min'

interface ApiKeyDbRow {
  tenant_id: string
  key_id: string
  key_hash: string
  key_prefix: string
  name: string
  created_at: string
  created_by: string
  revoked_at: string | null
  revoked_by: string
  version: number
  is_deleted: number
}

/**
 * In-memory DB mock that mimics ReplacingMergeTree(version, is_deleted)
 * semantics: latest row per (tenant_id, key_id) wins on FINAL, and
 * is_deleted=1 rows are filtered out.
 */
function mockDb(): { db: DbClient; rows: ApiKeyDbRow[] } {
  const rows: ApiKeyDbRow[] = []
  const db = {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      // Collapse to latest version per (tenant, key_id) — mirrors FINAL.
      // Iterate in insertion order so on `version` ties (same millisecond
      // boundary between create + revoke) the *later* insert wins. Real
      // ClickHouse FINAL with a ReplacingMergeTree behaves the same way
      // for ties once parts merge.
      const latest = new Map<string, ApiKeyDbRow>()
      for (const r of rows) {
        const key = `${r.tenant_id}\0${r.key_id}`
        const cur = latest.get(key)
        if (!cur || r.version >= cur.version) latest.set(key, r)
      }
      let result = [...latest.values()].filter((r) => r.is_deleted === 0)

      // Apply WHERE filters present in the test queries
      const tenantFilter = params.query_params.tenant_id as string | undefined
      const keyIdFilter = params.query_params.key_id as string | undefined
      if (tenantFilter) result = result.filter((r) => r.tenant_id === tenantFilter)
      if (keyIdFilter) result = result.filter((r) => r.key_id === keyIdFilter)
      // Mirror ORDER BY created_at DESC for list()
      if (/ORDER BY created_at DESC/.test(params.query)) {
        result.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      }
      return result
    },
    insert: async (params: { table: string; values: unknown[] }) => {
      for (const v of params.values) {
        rows.push(v as ApiKeyDbRow)
      }
    },
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, rows }
}

describe('ApiKeyStore', () => {
  // Helper: matches the production bootstrap order (refresh before serving).
  async function readyStore(db?: DbClient, opts: { maxPerTenant?: number } = {}) {
    const store = new ApiKeyStore({ db, logger: silentLogger, hmacSecret: SECRET, ...opts })
    await store.refresh()
    return store
  }

  it('create returns a raw key once, stores only the hash', async () => {
    const { db, rows } = mockDb()
    const store = await readyStore(db)

    const { key, rawKey } = await store.create({
      tenantId: 'tenant-a',
      name: 'production',
      createdBy: 'admin',
    })

    assert.match(rawKey, /^lw_[a-z2-7]{32}$/, 'raw key has expected format')
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0]?.key_hash, rawKey, 'raw key must not equal stored hash')
    assert.notEqual(rows[0]?.key_hash, '', 'hash must be present')
    assert.equal(rows[0]?.tenant_id, 'tenant-a')
    assert.equal(key.prefix.startsWith('lw_'), true)
    assert.equal(key.prefix.length, 11, 'prefix is lw_ + 8 chars')
  })

  it('list omits raw key + hash; returns metadata only', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    await store.create({ tenantId: 'tenant-a', name: 'one', createdBy: 'admin' })

    const list = await store.list('tenant-a')
    assert.equal(list.length, 1)
    const item = list[0] as Record<string, unknown>
    assert.ok(!('key' in item), 'list must not expose raw key')
    assert.ok(!('keyHash' in item), 'list must not expose hash')
    assert.ok(!('hash' in item), 'list must not expose hash')
    assert.equal((item as { name: string }).name, 'one')
  })

  it('validate accepts raw key and returns tenant + keyId', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    const { key, rawKey } = await store.create({
      tenantId: 'tenant-a',
      name: 'one',
      createdBy: 'admin',
    })

    const result = store.validate(rawKey)
    assert.ok(result, 'validate should accept the raw key')
    assert.equal(result.tenantId, 'tenant-a')
    assert.equal(result.keyId, key.keyId)
  })

  it('validate rejects unknown keys', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    assert.equal(store.validate('lw_definitelynotreal'), undefined)
  })

  it('validate rejects revoked keys', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    const { key, rawKey } = await store.create({
      tenantId: 'tenant-a',
      name: 'one',
      createdBy: 'admin',
    })

    await store.revoke({ tenantId: 'tenant-a', keyId: key.keyId, revokedBy: 'admin' })
    assert.equal(store.validate(rawKey), undefined, 'revoked key must not validate')
  })

  it('revoke is tenant-scoped — tenant A cannot revoke tenant B keys', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    const { key: keyA, rawKey: rawA } = await store.create({
      tenantId: 'tenant-a',
      name: 'a-key',
      createdBy: 'admin-a',
    })

    // Tenant B attempts to revoke tenant A's key by passing tenant-b's id.
    const ok = await store.revoke({
      tenantId: 'tenant-b',
      keyId: keyA.keyId,
      revokedBy: 'admin-b',
    })
    assert.equal(ok, false, 'cross-tenant revoke must return false')
    assert.ok(store.validate(rawA), 'tenant-a key must still validate')
  })

  it('revoke is idempotent', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    const { key } = await store.create({
      tenantId: 'tenant-a',
      name: 'one',
      createdBy: 'admin',
    })
    const first = await store.revoke({ tenantId: 'tenant-a', keyId: key.keyId, revokedBy: 'admin' })
    const second = await store.revoke({
      tenantId: 'tenant-a',
      keyId: key.keyId,
      revokedBy: 'admin',
    })
    assert.equal(first, true)
    assert.equal(second, false, 'second revoke is a no-op')
  })

  it('per-tenant cap prevents key spam', async () => {
    const { db } = mockDb()
    const store = await readyStore(db, { maxPerTenant: 2 })
    await store.create({ tenantId: 'tenant-a', name: 'a1', createdBy: 'admin' })
    await store.create({ tenantId: 'tenant-a', name: 'a2', createdBy: 'admin' })
    await assert.rejects(
      () => store.create({ tenantId: 'tenant-a', name: 'a3', createdBy: 'admin' }),
      (err: unknown) => err instanceof ApiKeyLimitError,
    )
    // Other tenant unaffected
    await store.create({ tenantId: 'tenant-b', name: 'b1', createdBy: 'admin' })
  })

  it('hashKey is HMAC-SHA256 (different secret → different hash)', () => {
    const a = new ApiKeyStore({ hmacSecret: SECRET })
    const b = new ApiKeyStore({ hmacSecret: 'different-secret-different-key' })
    const raw = 'lw_abc123'
    assert.notEqual(a.hashKey(raw), b.hashKey(raw), 'hash must depend on secret')
    assert.equal(a.hashKey(raw), a.hashKey(raw), 'hash is deterministic')
    assert.match(a.hashKey(raw), /^[0-9a-f]{64}$/, 'hash is 32-byte hex')
  })

  it('refresh loads only active keys into the cache', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    await store.refresh() // gate the cap-bypass guard

    const { rawKey: liveKey } = await store.create({
      tenantId: 'tenant-a',
      name: 'live',
      createdBy: 'admin',
    })
    const { key: deadKey, rawKey: revokedRaw } = await store.create({
      tenantId: 'tenant-a',
      name: 'dead',
      createdBy: 'admin',
    })
    await store.revoke({ tenantId: 'tenant-a', keyId: deadKey.keyId, revokedBy: 'admin' })

    // Build a fresh store against the same db — cache only populated via refresh().
    const fresh = new ApiKeyStore({ db, logger: silentLogger, hmacSecret: SECRET })
    const { count } = await fresh.refresh()
    assert.equal(count, 1, 'only the active key is in the cache')
    assert.ok(fresh.validate(liveKey), 'active key validates after refresh')
    assert.equal(fresh.validate(revokedRaw), undefined, 'revoked key does not validate')
  })

  it('seedFromBootstrap inserts env-loaded keys idempotently', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)

    const first = await store.seedFromBootstrap({
      tenantId: 'tenant-a',
      rawKey: 'lw_bootstrapkeyfromenv',
      name: 'env',
    })
    const second = await store.seedFromBootstrap({
      tenantId: 'tenant-a',
      rawKey: 'lw_bootstrapkeyfromenv',
      name: 'env',
    })
    assert.equal(first, true)
    assert.equal(second, false, 're-seeding the same key must be a no-op')
    assert.ok(store.validate('lw_bootstrapkeyfromenv'), 'seeded key validates')
  })

  // Regression: bootstrap admin landed in tenant 'default' even when
  // LOGWEAVE_API_KEYS was configured, because index.ts cleared config.apiKeys
  // before reading the first tenant. firstTenantId() lets the bootstrap path
  // read from the DB-backed cache instead. See issue #219.
  it('firstTenantId returns undefined when the store has no keys', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    assert.equal(store.firstTenantId(), undefined)
  })

  it('firstTenantId returns the first cached tenant after seeding', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    await store.seedFromBootstrap({
      tenantId: 'dev-tenant',
      rawKey: 'lw_devkeyforbootstrap',
      name: 'bootstrap',
    })
    assert.equal(store.firstTenantId(), 'dev-tenant')
  })

  it('firstTenantId preserves insertion order across multiple tenants', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    await store.seedFromBootstrap({
      tenantId: 'acme-prod',
      rawKey: 'lw_acmekeyone1234567',
      name: 'bootstrap',
    })
    await store.seedFromBootstrap({
      tenantId: 'acme-staging',
      rawKey: 'lw_acmekeytwo1234567',
      name: 'bootstrap',
    })
    assert.equal(
      store.firstTenantId(),
      'acme-prod',
      'first seeded tenant wins — used by admin bootstrap to pick a sensible default',
    )
  })

  it('getAllTenantIds returns empty when the store has no keys', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    assert.deepEqual(store.getAllTenantIds(), [])
  })

  it('getAllTenantIds returns distinct tenants across cached keys (#287)', async () => {
    const { db } = mockDb()
    const store = await readyStore(db)
    // Two keys for acme, one for globex — the reconcile sweep needs each tenant
    // once, not once per key.
    await store.seedFromBootstrap({
      tenantId: 'acme',
      rawKey: 'lw_acmekeyone1234567',
      name: 'k1',
    })
    await store.seedFromBootstrap({
      tenantId: 'acme',
      rawKey: 'lw_acmekeytwo1234567',
      name: 'k2',
    })
    await store.seedFromBootstrap({
      tenantId: 'globex',
      rawKey: 'lw_globexkey12345678',
      name: 'k3',
    })
    assert.deepEqual([...store.getAllTenantIds()].sort(), ['acme', 'globex'])
  })

  it('throws if hmacSecret is missing', () => {
    assert.throws(() => new ApiKeyStore({ hmacSecret: '' }))
  })

  // ---------------------------------------------------------------------------
  // Cap-bypass guard: create() must not run before refresh() has succeeded.
  // ---------------------------------------------------------------------------

  it('isReady is false before any refresh has run', () => {
    const { db } = mockDb()
    const store = new ApiKeyStore({ db, logger: silentLogger, hmacSecret: SECRET })
    assert.equal(store.isReady, false)
  })

  it('isReady flips to true after a successful refresh', async () => {
    const { db } = mockDb()
    const store = new ApiKeyStore({ db, logger: silentLogger, hmacSecret: SECRET })
    await store.refresh()
    assert.equal(store.isReady, true)
  })

  it('isReady stays false when refresh fails (DB throws)', async () => {
    const failingDb = {
      query: async () => {
        throw new Error('CH down')
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => false,
      close: async () => {},
    } as unknown as DbClient
    const store = new ApiKeyStore({ db: failingDb, logger: silentLogger, hmacSecret: SECRET })
    const { count } = await store.refresh()
    assert.equal(count, 0)
    assert.equal(store.isReady, false)
  })

  it('create() refuses to run before initial refresh succeeded (cap bypass guard)', async () => {
    const { db } = mockDb()
    const store = new ApiKeyStore({ db, logger: silentLogger, hmacSecret: SECRET })
    // Note: no refresh() call. Cache is empty BUT the DB might not be —
    // an attacker who can reach this path could otherwise create
    // `maxPerTenant` keys on top of an existing population.
    await assert.rejects(
      () => store.create({ tenantId: 'tenant-a', name: 'x', createdBy: 'admin' }),
      (err: unknown) => err instanceof ApiKeyStoreNotReadyError,
    )
  })

  it('create() works after refresh succeeds even when the cache is empty', async () => {
    // Empty DB → refresh succeeds with count 0 → cache empty but isReady=true.
    // create() should now be allowed.
    const { db } = mockDb()
    const store = await readyStore(db)
    await store.refresh()
    const result = await store.create({
      tenantId: 'tenant-a',
      name: 'first-key',
      createdBy: 'admin',
    })
    assert.ok(result.rawKey)
  })
})
