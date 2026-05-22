import type { DbClient } from '../client.js'
import { clamp, DEFAULT_HOURS, MAX_HOURS, tenantQuery } from '../queries.js'

export interface TemplateEventRow {
  timestamp: string
  trace_id: string
  route: string
  duration_ms: string
  level: string
  service: string
  status_code: string
}

/**
 * Individual log_metadata rows for a single template, used for drill-down.
 */
export async function queryTemplateEvents(
  db: DbClient,
  tenantId: string,
  options: {
    templateId: string
    statusCode?: number
    since?: string
    until?: string
    hours?: number
    limit?: number
  },
): Promise<TemplateEventRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)

  const timeFilter = options.since && options.until
    ? 'AND timestamp >= parseDateTimeBestEffort({since:String}) AND timestamp <= parseDateTimeBestEffort({until:String})'
    : 'AND timestamp > now64(3) - toIntervalHour({hours:UInt32})'

  const statusCodeFilter = options.statusCode
    ? 'AND status_code = {status_code:UInt16}'
    : ''

  const query = `
SELECT
    timestamp, trace_id, route, duration_ms, level, service, status_code
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND template_id = {template_id:String}
  ${timeFilter}
  ${statusCodeFilter}
ORDER BY timestamp DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = {
    template_id: options.templateId,
    hours,
    limit,
  }
  if (options.statusCode) params.status_code = options.statusCode
  if (options.since) params.since = options.since
  if (options.until) params.until = options.until

  return db.query<TemplateEventRow>(tenantQuery(query, tenantId, params))
}
