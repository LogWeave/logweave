import { createHash } from 'node:crypto'
import { uuidv7 } from '../uuid.js'
import type { IngestResult } from './ingest.js'

/**
 * Batch-level idempotency for ingest (#268). At-least-once clients (the durable
 * pump, #270) retry a batch after a timeout or 5xx; without dedup that double-
 * counts. We remember the result of each recently-seen batch key and replay it
 * instead of re-ingesting.
 *
 * The key is the client's `Idempotency-Key` header when present, else a hash of
 * the batch's source-assigned `event_id`s (stable across replays). A batch with
 * neither has no stable identity and is always processed.
 *
 * Scope: in-memory, per-process, best-effort. It collapses sequential resubmits
 * (the actual retry pattern) since the result is recorded only after a
 * successful insert — so a retry after a failure still goes through. It does NOT
 * guard against two identical batches racing concurrently; the durable backstop
 * for that is ReplacingMergeTree (#267) — but note the dedup key is the full
 * ORDER BY (tenant, service, timestamp, level, event_id), so it only collapses
 * a concurrent race when the events carry a stable source timestamp (otherwise
 * each call stamps its own ingest-time and the rows differ). SDK/pump traffic
 * carries timestamps; the gap is timestamp-less ad-hoc sources racing.
 */

const TTL_MS = 5 * 60_000
const MAX_ENTRIES = 10_000

interface Entry {
  result: IngestResult
  expiry: number
}

const cache = new Map<string, Entry>()

function cacheKey(tenantId: string, key: string): string {
  return `${tenantId}\n${key}`
}

/** Canonical hyphenated UUID, any version (the `event_id` column is `UUID`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Extract a source-assigned `event_id` from a raw event. Returns it only if it
 * is a well-formed UUID — the ClickHouse column is `UUID`, so a non-UUID string
 * would fail the (synchronous) insert and poison the whole batch. A malformed or
 * absent value yields undefined, and the caller substitutes a generated UUIDv7.
 */
export function extractEventId(raw: unknown): string | undefined {
  if (typeof raw === 'object' && raw !== null) {
    const v = (raw as Record<string, unknown>).event_id
    if (typeof v === 'string' && UUID_RE.test(v)) return v
  }
  return undefined
}

/**
 * The final dedup key for an event: its source-assigned `event_id` when
 * well-formed, else a generated UUIDv7 fallback. Shared by `ingestBatch` (the
 * synchronous insert path) and the Vector forwarder so both stamp the same key
 * — ReplacingMergeTree collapses the two only if they agree.
 */
export function ensureEventId(raw: unknown): string {
  return extractEventId(raw) ?? uuidv7()
}

/** Deterministic batch key from source-assigned event_ids (order-independent). */
export function computeBatchKey(eventIds: string[]): string {
  // Join on a newline — a delimiter that can't appear inside a UUID — so two
  // distinct id sets can't collide into the same key.
  const sorted = [...eventIds].sort()
  return createHash('sha256').update(sorted.join('\n')).digest('hex')
}

/** Return the cached result for a recently-seen batch key, or undefined. */
export function getCachedResult(tenantId: string, key: string): IngestResult | undefined {
  const k = cacheKey(tenantId, key)
  const entry = cache.get(k)
  if (!entry) return undefined
  if (entry.expiry < Date.now()) {
    cache.delete(k)
    return undefined
  }
  return entry.result
}

/** Remember a batch result under its key (TTL'd, size-bounded). */
export function recordResult(tenantId: string, key: string, result: IngestResult): void {
  if (cache.size >= MAX_ENTRIES) {
    // Map preserves insertion order — drop the oldest entry.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(cacheKey(tenantId, key), { result, expiry: Date.now() + TTL_MS })
}

/** Test-only: clear all remembered keys so cases don't leak into each other. */
export function clearIdempotencyCache(): void {
  cache.clear()
}
