import type { DbClient } from '../client.js'
import { clamp, DEFAULT_HOURS, MAX_HOURS, type PaginationOptions, tenantQuery } from '../queries.js'

interface DashboardVolumeRow {
  interval_start: string
  service: string
  log_count: number
  error_count: number
}

interface DashboardVolumeOptions extends PaginationOptions {
  service?: string
  offset?: number
  level?: string[]
}

/**
 * Returns time-series volume data from service_stats.
 * Supports offset for comparison windows (e.g., "same hours, one day ago").
 */
export async function queryDashboardVolume(
  db: DbClient,
  tenantId: string,
  options?: DashboardVolumeOptions,
): Promise<DashboardVolumeRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const offset = Math.max(0, Math.round(options?.offset ?? 0))
  const service = options?.service
  const levels = options?.level

  const serviceFilter = service ? 'AND service = {service:String}' : ''
  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const timeFilter =
    offset > 0
      ? `AND interval_start > now64(3) - toIntervalHour({window_end:UInt32})
  AND interval_start <= now64(3) - toIntervalHour({offset:UInt32})`
      : 'AND interval_start > now64(3) - toIntervalHour({hours:UInt32})'

  // Use template_stats (5-min buckets) for smoother volume charts
  // instead of service_stats (1-hour buckets) which looks blocky
  const query = `
/* @query: dashboardVolume */
SELECT
    interval_start,
    service,
    countMerge(occurrence_count)  AS log_count,
    countMerge(error_count)      AS error_count
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  ${timeFilter}
  ${serviceFilter}
  ${levelFilter}
GROUP BY interval_start, service
ORDER BY interval_start ASC`

  const params: Record<string, unknown> =
    offset > 0 ? { window_end: hours + offset, offset } : { hours }
  if (service) params.service = service
  if (levels?.length) params.levels = levels

  return db.query<DashboardVolumeRow>(tenantQuery(query, tenantId, params))
}
