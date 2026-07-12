import { createHmac, randomBytes } from 'node:crypto'
import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import { uuidv7 } from '../uuid.js'

const DEFAULT_MAX_KEYS_PER_TENANT = 50
const DEFAULT_REFRESH_INTERVAL_MS = 60_000
const STARTUP_LOAD_LIMIT = 10_000

const KEY_PREFIX = 'lw_'
const KEY_RANDOM_BYTES = 20 // → 32 base32-ish chars

// Lowercase alphanumeric (RFC 4648-ish minus '=' padding). Matches the AWS
// charset that we use elsewhere for IAM role session names.
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

interface ApiKeyRow {
  tenant_id: string
  key_id: string
  key_hash: string
  key_prefix: string
  name: string
  created_at: string
  created_by: string
  revoked_at: string | null
  revoked_by: string
}

export interface ApiKey {
  keyId: string
  tenantId: string
  name: string
  prefix: string
  createdAt: string
  createdBy: string
  revokedAt?: string
  revokedBy?: string
}

export interface CachedKey {
  /** Hex-encoded HMAC-SHA256 digest of the raw key. Indexed lookup. */
  hash: string
  tenantId: string
  keyId: string
}

export interface ApiKeyStoreOpts {
  db?: DbClient
  logger?: pino.Logger
  /** HMAC secret (HKDF-domain-separated from encryption key). Required. */
  hmacSecret: string
  /** ms between DB → cache refreshes. Default 60s. */
  refreshIntervalMs?: number
  maxPerTenant?: number
  /** Test-only: inject a deterministic key generator. */
  generateKey?: () => string
  /** Test-only: inject a deterministic clock. */
  now?: () => Date
}

/**
 * Per-tenant API key store. Backs the auth middleware's hash → tenant lookup.
 *
 * Design:
 * - Raw keys are NEVER stored. We compute HMAC-SHA256(rawKey, hmacSecret) on
 *   create and persist the hex digest. The same HMAC is computed on every
 *   auth check.
 * - HMAC (not bare SHA-256) so a leaked DB doesn't yield offline-crackable
 *   hashes; an attacker also needs `hmacSecret`. Domain-separated from the
 *   config-encryption key with a fixed label.
 * - In-memory cache for hot-path lookup. Refreshed every 60s from ClickHouse.
 *   Revocation visible within one refresh window — documented as a known
 *   limitation. (Adding a DB hit per request would dwarf the auth-middleware
 *   work for every API call.)
 * - Show-once on create: the raw key only ever returns from `create()`.
 *   `list()` returns metadata + prefix, never the secret.
 */
export class ApiKeyStore {
  private readonly db?: DbClient
  private readonly logger?: pino.Logger
  private readonly hmacSecret: string
  private readonly refreshIntervalMs: number
  private readonly maxPerTenant: number
  private readonly generateKeyFn: () => string
  private readonly now: () => Date

  /** Active (non-revoked) keys keyed by hash for O(1) auth lookup. */
  private cache = new Map<string, CachedKey>()
  private refreshHandle: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /**
   * True once a refresh has completed without throwing. Until then we must
   * NOT let `create()` enforce the per-tenant cap from an empty cache — the
   * cap is a security control. A cold boot where the first refresh fails
   * (transient DB hiccup) would otherwise let a tenant create
   * `maxPerTenant` keys on top of whatever already exists in the table.
   */
  private initialRefreshSucceeded = false

  constructor(opts: ApiKeyStoreOpts) {
    if (!opts.hmacSecret) {
      throw new Error('ApiKeyStore: hmacSecret is required')
    }
    this.db = opts.db
    this.logger = opts.logger
    this.hmacSecret = opts.hmacSecret
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    this.maxPerTenant = opts.maxPerTenant ?? DEFAULT_MAX_KEYS_PER_TENANT
    this.generateKeyFn = opts.generateKey ?? defaultGenerateKey
    this.now = opts.now ?? (() => new Date())
  }

  /**
   * HMAC-SHA256 of the raw key, hex-encoded. Domain-separated so the same
   * server-side secret can be reused for other HMAC purposes without
   * cross-purpose collisions.
   */
  hashKey(rawKey: string): string {
    return createHmac('sha256', this.hmacSecret).update(`api-key:${rawKey}`).digest('hex')
  }

  /** Pull all non-revoked keys from ClickHouse into the cache. */
  async refresh(): Promise<{ count: number }> {
    if (!this.db) return { count: 0 }
    try {
      const rows = await this.db.query<ApiKeyRow>({
        query: `
          SELECT tenant_id, key_id, key_hash, key_prefix, name, created_at,
                 created_by, revoked_at, revoked_by
          FROM logweave.api_keys FINAL
          WHERE is_deleted = 0
          LIMIT {limit:UInt32}
        `,
        query_params: { limit: STARTUP_LOAD_LIMIT },
      })
      const next = new Map<string, CachedKey>()
      for (const row of rows) {
        // Defensive: ReplacingMergeTree+FINAL+is_deleted should already filter
        // revoked rows, but a stale-row race during merge is possible. Belt
        // and braces — revoked_at!=null means revoked.
        if (row.revoked_at) continue
        next.set(row.key_hash, {
          hash: row.key_hash,
          tenantId: row.tenant_id,
          keyId: row.key_id,
        })
      }
      this.cache = next
      this.initialRefreshSucceeded = true
      this.logger?.debug({ count: next.size }, 'ApiKeyStore cache refreshed')
      return { count: next.size }
    } catch (err) {
      this.logger?.warn({ err }, 'ApiKeyStore refresh failed; keeping previous cache')
      return { count: this.cache.size }
    }
  }

  /**
   * True once at least one refresh has succeeded since boot. Used by `create()`
   * to gate the per-tenant cap check — see {@link initialRefreshSucceeded}.
   * Exposed so callers (e.g. health checks) can also observe it.
   */
  get isReady(): boolean {
    return this.initialRefreshSucceeded
  }

  /** Start the background refresh loop. Idempotent. */
  start(): void {
    if (this.refreshHandle || this.stopped) return
    const tick = async (): Promise<void> => {
      await this.refresh()
      if (this.stopped) return
      this.refreshHandle = setTimeout(tick, this.refreshIntervalMs)
      this.refreshHandle.unref()
    }
    this.refreshHandle = setTimeout(tick, this.refreshIntervalMs)
    this.refreshHandle.unref()
  }

  /** Stop the background refresh loop. */
  stop(): void {
    this.stopped = true
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle)
      this.refreshHandle = null
    }
  }

  /**
   * Validate a raw key. Returns tenantId+keyId if active, undefined otherwise.
   * Auth middleware hot path — must not hit the DB.
   */
  validate(rawKey: string): { tenantId: string; keyId: string } | undefined {
    const hash = this.hashKey(rawKey)
    const hit = this.cache.get(hash)
    if (!hit) return undefined
    return { tenantId: hit.tenantId, keyId: hit.keyId }
  }

  /**
   * Generate a new key and persist its hash. Returns the *raw* key — caller
   * surfaces it to the operator once, then it is unrecoverable.
   */
  async create(args: {
    tenantId: string
    name: string
    createdBy: string
  }): Promise<{ key: ApiKey; rawKey: string }> {
    if (!this.db) throw new Error('ApiKeyStore.create requires a db')
    if (!args.name.trim()) throw new Error('name is required')

    // Gate on the initial refresh having succeeded. Without it the cache is
    // empty even if the DB already has keys, and the per-tenant cap below
    // would be enforced against zero — allowing a runaway tenant to silently
    // exceed `maxPerTenant`. Fail loudly instead.
    if (!this.initialRefreshSucceeded) {
      throw new ApiKeyStoreNotReadyError()
    }

    // Enforce per-tenant cap. Counted from the cache to avoid an extra DB
    // round-trip; correct after the gate above guarantees the cache reflects
    // current DB state.
    const tenantActiveCount = [...this.cache.values()].filter(
      (k) => k.tenantId === args.tenantId,
    ).length
    if (tenantActiveCount >= this.maxPerTenant) {
      throw new ApiKeyLimitError(this.maxPerTenant)
    }

    const rawKey = this.generateKeyFn()
    const hash = this.hashKey(rawKey)
    const prefix = rawKey.slice(0, KEY_PREFIX.length + 8) // e.g. "lw_abc12345"
    const createdAt = this.now()
    const keyId = uuidv7()
    const version = createdAt.getTime()

    await this.db.insert({
      table: 'logweave.api_keys',
      values: [
        {
          tenant_id: args.tenantId,
          key_id: keyId,
          key_hash: hash,
          key_prefix: prefix,
          name: args.name.trim(),
          created_at: createdAt.toISOString(),
          created_by: args.createdBy,
          revoked_at: null,
          revoked_by: '',
          version,
          is_deleted: 0,
        },
      ],
      format: 'JSONEachRow',
    })

    // Write through to the cache immediately so the new key works without
    // waiting for the next refresh tick.
    this.cache.set(hash, { hash, tenantId: args.tenantId, keyId })

    return {
      key: {
        keyId,
        tenantId: args.tenantId,
        name: args.name.trim(),
        prefix,
        createdAt: createdAt.toISOString(),
        createdBy: args.createdBy,
      },
      rawKey,
    }
  }

  /**
   * List all keys for a tenant — active and revoked. Caller filters as needed.
   * Returns metadata only; the raw key / hash is never exposed.
   */
  async list(tenantId: string): Promise<ApiKey[]> {
    if (!this.db) return []
    const rows = await this.db.query<ApiKeyRow>({
      query: `
        SELECT tenant_id, key_id, key_hash, key_prefix, name, created_at,
               created_by, revoked_at, revoked_by
        FROM logweave.api_keys FINAL
        WHERE tenant_id = {tenant_id:String}
          AND is_deleted = 0
        ORDER BY created_at DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { tenant_id: tenantId, limit: STARTUP_LOAD_LIMIT },
    })
    return rows.map((row) => ({
      keyId: row.key_id,
      tenantId: row.tenant_id,
      name: row.name,
      prefix: row.key_prefix,
      createdAt: row.created_at,
      createdBy: row.created_by,
      revokedAt: row.revoked_at ?? undefined,
      revokedBy: row.revoked_by || undefined,
    }))
  }

  /**
   * Soft-delete a key. Tenant-scoped: a tenant's admin cannot revoke another
   * tenant's key. Returns true if a key was revoked.
   */
  async revoke(args: { tenantId: string; keyId: string; revokedBy: string }): Promise<boolean> {
    if (!this.db) return false

    // Read current row to confirm ownership + grab existing fields. Without
    // this read a malicious tenantA could submit tenantB's keyId and we'd
    // never check ownership at the SQL layer.
    const existing = await this.db.query<ApiKeyRow>({
      query: `
        SELECT tenant_id, key_id, key_hash, key_prefix, name, created_at,
               created_by, revoked_at, revoked_by
        FROM logweave.api_keys FINAL
        WHERE tenant_id = {tenant_id:String}
          AND key_id = {key_id:String}
          AND is_deleted = 0
        LIMIT 1
      `,
      query_params: { tenant_id: args.tenantId, key_id: args.keyId },
    })
    const row = existing[0]
    if (!row) return false
    if (row.revoked_at) return false // already revoked, idempotent no-op

    const revokedAt = this.now()
    await this.db.insert({
      table: 'logweave.api_keys',
      values: [
        {
          tenant_id: row.tenant_id,
          key_id: row.key_id,
          key_hash: row.key_hash,
          key_prefix: row.key_prefix,
          name: row.name,
          created_at: row.created_at,
          created_by: row.created_by,
          revoked_at: revokedAt.toISOString(),
          revoked_by: args.revokedBy,
          version: revokedAt.getTime(),
          is_deleted: 1,
        },
      ],
      format: 'JSONEachRow',
    })

    // Write through: drop the cache entry now so the key stops working
    // immediately for this process. Other processes pick it up at their
    // next refresh tick.
    this.cache.delete(row.key_hash)
    return true
  }

  /**
   * Seed a key with a pre-generated raw value. Used at bootstrap to import
   * env-loaded keys into the table on first boot. Returns false if a key
   * with the same hash already exists for this tenant (idempotent boot).
   */
  async seedFromBootstrap(args: {
    tenantId: string
    rawKey: string
    name: string
  }): Promise<boolean> {
    if (!this.db) return false
    const hash = this.hashKey(args.rawKey)
    if (this.cache.has(hash)) return false

    const createdAt = this.now()
    const keyId = uuidv7()
    const version = createdAt.getTime()
    const prefix = args.rawKey.slice(0, KEY_PREFIX.length + 8)

    await this.db.insert({
      table: 'logweave.api_keys',
      values: [
        {
          tenant_id: args.tenantId,
          key_id: keyId,
          key_hash: hash,
          key_prefix: prefix,
          name: args.name,
          created_at: createdAt.toISOString(),
          created_by: 'bootstrap',
          revoked_at: null,
          revoked_by: '',
          version,
          is_deleted: 0,
        },
      ],
      format: 'JSONEachRow',
    })
    this.cache.set(hash, { hash, tenantId: args.tenantId, keyId })
    return true
  }

  /** Cache size — for ops/metrics. */
  get size(): number {
    return this.cache.size
  }

  /**
   * First known tenant ID from the cache, in insertion order. Used by the
   * admin-bootstrap path so the default admin user lands in the same tenant
   * as the seeded API keys, not the literal string 'default'. Returns
   * undefined when no keys are loaded.
   */
  firstTenantId(): string | undefined {
    const first = this.cache.values().next()
    return first.done ? undefined : first.value.tenantId
  }

  /**
   * Distinct tenant IDs across all cached keys — the authoritative set of
   * tenants that can authenticate to ingest. The archive reconcile sweep (#287)
   * unions this with the settings-store tenants so a forward-only tenant (one
   * that POSTs to /v1/ingest/batch but never persists a tenant_settings row) is
   * still swept; without it, that tenant's forwarded objects stay unqueryable.
   */
  getAllTenantIds(): string[] {
    const ids = new Set<string>()
    for (const entry of this.cache.values()) ids.add(entry.tenantId)
    return [...ids]
  }
}

export class ApiKeyLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`tenant has reached the maximum of ${limit} API keys`)
    this.name = 'ApiKeyLimitError'
  }
}

/**
 * Thrown when create() runs before the initial cache refresh has succeeded.
 * Maps to HTTP 503 — the operator should investigate why ClickHouse is
 * unreachable, and clients should retry after backoff.
 */
export class ApiKeyStoreNotReadyError extends Error {
  constructor() {
    super('api key store is not ready yet — initial DB refresh has not succeeded')
    this.name = 'ApiKeyStoreNotReadyError'
  }
}

/**
 * Generate a new key. Format: `lw_<32-char base32-ish>`. The prefix lets
 * operators identify a key in logs/configs without exposing the secret.
 */
function defaultGenerateKey(): string {
  const bytes = randomBytes(KEY_RANDOM_BYTES)
  let out = ''
  // Pull 5 bits at a time using a rolling buffer. 20 bytes = 160 bits = 32
  // base32 chars exactly, no padding.
  let bits = 0
  let buffer = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      const idx = (buffer >>> (bits - 5)) & 0x1f
      out += BASE32_ALPHABET[idx]
      bits -= 5
    }
  }
  return KEY_PREFIX + out
}
