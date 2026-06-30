import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

/**
 * Durable per-tenant watermark for the archive reconciliation sweep (epic #265,
 * #279). `last_key` is the high-water mark: every archived object lexically
 * <= it is confirmed present in `log_metadata`. The sweep lists from here
 * forward, so a transiently-missed object stays in the listing window until it
 * actually lands (the watermark only advances past confirmed objects).
 *
 * `argMax(..., version)` reads the latest write without a FINAL merge.
 */
const GET_CURSOR = `
SELECT argMax(last_key, version) AS last_key
FROM logweave.archive_reconcile_cursor
WHERE tenant_id = {tenant_id:String}
GROUP BY tenant_id`

/**
 * Of the given object keys, which already exist in `log_metadata` for this
 * tenant (by `source_ref`). The sweep enqueues the complement (missing keys).
 * Tenant-scoped so one tenant's sweep can never observe another's objects.
 */
const EXISTING_SOURCE_REFS = `
SELECT DISTINCT source_ref
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND source_ref IN ({keys:Array(String)})`

interface CursorRow {
  last_key: string
}

interface SourceRefRow {
  source_ref: string
}

/** Read the tenant's reconciliation watermark, or '' when none recorded yet. */
export async function getReconcileCursor(db: DbClient, tenantId: string): Promise<string> {
  const rows = await db.query<CursorRow>(tenantQuery(GET_CURSOR, tenantId))
  return rows[0]?.last_key ?? ''
}

/** Advance the tenant's watermark. A fresh version (now-ms) wins the dedup. */
export async function setReconcileCursor(
  db: DbClient,
  tenantId: string,
  lastKey: string,
): Promise<void> {
  await db.insert({
    table: 'logweave.archive_reconcile_cursor',
    values: [{ tenant_id: tenantId, last_key: lastKey, version: Date.now() }],
    format: 'JSONEachRow',
  })
}

// @clickhouse/client binds array params into the HTTP query string; a few
// thousand ~80-byte keys would approach http_max_uri_size. Chunk to keep each
// request's URL comfortably bounded.
const MEMBERSHIP_CHUNK = 1000

/** Subset of `keys` already ingested for this tenant (matched by source_ref). */
export async function getExistingSourceRefs(
  db: DbClient,
  tenantId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>()
  for (let i = 0; i < keys.length; i += MEMBERSHIP_CHUNK) {
    const chunk = keys.slice(i, i + MEMBERSHIP_CHUNK)
    const rows = await db.query<SourceRefRow>(
      tenantQuery(EXISTING_SOURCE_REFS, tenantId, { keys: chunk }),
    )
    for (const r of rows) found.add(r.source_ref)
  }
  return found
}
