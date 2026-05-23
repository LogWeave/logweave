import type { DbClient } from '../client.js'
import {
  clamp,
  DEFAULT_HOURS,
  MAX_HOURS,
  type PaginationOptions,
  tenantQuery,
} from '../queries.js'

export interface OverviewAggregatesRow {
  total_events: number | string
  error_count: number | string
  warn_count: number | string
  new_template_count: number | string
}

export interface OverviewCountsRow {
  unique_templates: number | string
  unclustered_count: number | string
  service_count: number | string
}

/**
 * Aggregate counts from service_stats (single row).
 * Used for the dashboard overview panel.
 */
export async function queryDashboardOverviewAggregates(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { level?: string[]; offsetHours?: number },
): Promise<OverviewAggregatesRow> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level
  const offsetHours = options?.offsetHours ?? 0

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''
  const startBound =
    offsetHours > 0
      ? 'AND interval_start BETWEEN now64(3) - toIntervalHour({end_hours:UInt32}) AND now64(3) - toIntervalHour({offset_hours:UInt32})'
      : 'AND interval_start > now64(3) - toIntervalHour({hours:UInt32})'

  const query = `
/* @query: overviewAggregates */
SELECT
    countMerge(log_count)             AS total_events,
    countMerge(error_count)         AS error_count,
    countMerge(warn_count)          AS warn_count,
    countMerge(new_template_count)  AS new_template_count
FROM logweave.service_stats
WHERE tenant_id = {tenant_id:String}
  ${startBound}
  ${levelFilter}`

  const params: Record<string, unknown> = { hours }
  if (offsetHours > 0) {
    params.offset_hours = offsetHours
    params.end_hours = offsetHours + hours
  }
  if (levels?.length) params.levels = levels

  const rows = await db.query<OverviewAggregatesRow>(tenantQuery(query, tenantId, params))
  return rows[0] ?? { total_events: 0, error_count: 0, warn_count: 0, new_template_count: 0 }
}

/**
 * Counts from log_metadata (single row).
 * Provides unique template count, unclustered count, and service count.
 */
export async function queryDashboardOverviewCounts(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { level?: string[]; offsetHours?: number },
): Promise<OverviewCountsRow> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level
  const offsetHours = options?.offsetHours ?? 0

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''
  const startBound =
    offsetHours > 0
      ? 'AND timestamp BETWEEN now64(3) - toIntervalHour({end_hours:UInt32}) AND now64(3) - toIntervalHour({offset_hours:UInt32})'
      : 'AND timestamp > now64(3) - toIntervalHour({hours:UInt32})'

  const query = `
/* @query: overviewCounts */
SELECT
    uniqIf(template_id, template_id != '0') AS unique_templates,
    countIf(template_id = '0')              AS unclustered_count,
    uniq(service)                           AS service_count
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  ${startBound}
  ${levelFilter}`

  const params: Record<string, unknown> = { hours }
  if (offsetHours > 0) {
    params.offset_hours = offsetHours
    params.end_hours = offsetHours + hours
  }
  if (levels?.length) params.levels = levels

  const rows = await db.query<OverviewCountsRow>(tenantQuery(query, tenantId, params))
  return rows[0] ?? { unique_templates: 0, unclustered_count: 0, service_count: 0 }
}
