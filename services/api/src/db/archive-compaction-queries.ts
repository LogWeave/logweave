import type { DbClient } from './client.js'

/**
 * Repoint the `source_ref` of every row pointing at one of the original
 * (now-compacted) objects to the new compacted object key (epic #265, #284).
 * Drill-down (#275) GETs objects by `source_ref`, so this must complete BEFORE
 * the originals are deleted from S3 — `mutations_sync = 2` makes the ALTER
 * synchronous so the caller can safely delete afterwards.
 *
 * Tenant-scoped: a tenant's compaction can only ever rewrite its own rows.
 */
export async function repointSourceRefs(
  db: DbClient,
  tenantId: string,
  oldKeys: readonly string[],
  newKey: string,
): Promise<void> {
  if (oldKeys.length === 0) return
  await db.command({
    query: `ALTER TABLE logweave.log_metadata
            UPDATE source_ref = {new_key:String}
            WHERE tenant_id = {tenant_id:String}
              AND source_ref IN ({old_keys:Array(String)})
            SETTINGS mutations_sync = 2`,
    query_params: { new_key: newKey, tenant_id: tenantId, old_keys: oldKeys },
  })
}
