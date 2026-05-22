import type { DbClient } from '../client.js'
import { clamp, DEFAULT_HOURS, MAX_HOURS, tenantQuery } from '../queries.js'

interface TemplateStatusCodeRow {
  status_code: number
  count: number
}

/**
 * Status code distribution for a specific template from log_metadata.
 * Filters out rows where status_code = 0 (no status code present).
 */
export async function queryTemplateStatusCodes(
  db: DbClient,
  tenantId: string,
  options: { hours?: number; templateId: string; since?: string; until?: string },
): Promise<TemplateStatusCodeRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)

  const timeFilter = options.since && options.until
    ? 'AND timestamp >= parseDateTimeBestEffort({since:String}) AND timestamp <= parseDateTimeBestEffort({until:String})'
    : 'AND timestamp > now64(3) - toIntervalHour({hours:UInt32})'

  const query = `
SELECT
    status_code,
    count() AS count
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  ${timeFilter}
  AND template_id = {template_id:String}
  AND status_code != 0
GROUP BY status_code
ORDER BY count DESC`

  const params: Record<string, unknown> = { template_id: options.templateId, hours }
  if (options.since) params.since = options.since
  if (options.until) params.until = options.until

  return db.query<TemplateStatusCodeRow>(tenantQuery(query, tenantId, params))
}
