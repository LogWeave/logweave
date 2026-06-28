import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

/**
 * Recent distinct archive object keys (`source_ref`) for a template, newest
 * first. These are the gzip NDJSON objects Vector wrote to the customer's
 * archive bucket (epic #265); drill-down GETs them by key and regex-scans for
 * lines matching the template (#275).
 *
 * No FINAL: GROUP BY source_ref already collapses ReplacingMergeTree replicas
 * of the same event, and we only need the distinct keys — so we avoid the FINAL
 * merge cost on the hot log_metadata table.
 */
const ARCHIVE_SOURCE_REFS = `
SELECT source_ref, max(timestamp) AS last_seen
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND template_id = {template_id:String}
  AND service = {service:String}
  AND source_type = 's3'
  AND source_ref != ''
  AND timestamp >= {since:DateTime64(3)}
GROUP BY source_ref
ORDER BY last_seen DESC
LIMIT {max_files:UInt32}`

interface SourceRefRow {
  source_ref: string
  last_seen: string
}

/**
 * Look up the most recent archive object keys for `templateId` in `service`,
 * within the last `hours`, capped at `maxFiles`. Empty when the template's
 * events were not archived to S3 (e.g. pre-archive data) — the caller then
 * falls back to user-configured connectors.
 */
export async function getArchiveSourceRefs(
  db: DbClient,
  tenantId: string,
  params: { templateId: string; service: string; hours: number; maxFiles: number },
): Promise<string[]> {
  const since = new Date(Date.now() - params.hours * 3_600_000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '')

  const rows = await db.query<SourceRefRow>(
    tenantQuery(ARCHIVE_SOURCE_REFS, tenantId, {
      template_id: params.templateId,
      service: params.service,
      since,
      max_files: params.maxFiles,
    }),
  )
  return rows.map((r) => r.source_ref)
}
