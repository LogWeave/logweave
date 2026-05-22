import type { DbClient } from '../client.js'
import {
  clamp,
  DEFAULT_HOURS,
  DEFAULT_STATS_LIMIT,
  MAX_HOURS,
  MAX_STATS_LIMIT,
  type PaginationOptions,
  tenantQuery,
} from '../queries.js'

interface DashboardServiceRow {
  service: string
  log_count: number
  error_count: number
  warn_count: number
  new_template_count: number
  avg_anomaly_score: number
}

/**
 * Aggregates service_stats across time intervals by service.
 * Returns top services by log count.
 */
export async function queryDashboardServices(
  db: DbClient,
  tenantId: string,
  options?: PaginationOptions & { level?: string[] },
): Promise<DashboardServiceRow[]> {
  const limit = clamp(options?.limit ?? DEFAULT_STATS_LIMIT, MAX_STATS_LIMIT)
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT
    service,
    countMerge(log_count)             AS log_count,
    countMerge(error_count)         AS error_count,
    countMerge(warn_count)          AS warn_count,
    countMerge(new_template_count)  AS new_template_count,
    avgMerge(avg_anomaly_score)       AS avg_anomaly_score
FROM logweave.service_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}
GROUP BY service
ORDER BY log_count DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { limit, hours }
  if (levels?.length) params.levels = levels

  return db.query<DashboardServiceRow>(tenantQuery(query, tenantId, params))
}
