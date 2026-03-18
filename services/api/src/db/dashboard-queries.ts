import type { DbClient } from './client.js'
import {
  clamp,
  DEFAULT_HOURS,
  DEFAULT_STATS_LIMIT,
  MAX_HOURS,
  MAX_STATS_LIMIT,
  type PaginationOptions,
  tenantQuery,
} from './queries.js'

// -- ClickHouse row interfaces (snake_case, matching query output) --

interface DashboardTemplateRow {
  template_id: string
  template_text: string
  service: string
  occurrence_count: number
  error_count: number
  avg_duration_ms: number
  max_anomaly_score: number
  first_seen: string
  last_seen: string
}

interface NewTemplateIdRow {
  template_id: string
}

interface DashboardServiceRow {
  service: string
  log_count: number
  error_count: number
  warn_count: number
  new_template_count: number
  avg_anomaly_score: number
}

interface DashboardVolumeRow {
  interval_start: string
  service: string
  log_count: number
  error_count: number
}

interface OverviewAggregatesRow {
  total_events: number
  error_count: number
  warn_count: number
  new_template_count: number
}

interface OverviewCountsRow {
  unique_templates: number
  unclustered_count: number
  service_count: number
}

interface TemplateSparklineRow {
  template_id: string
  interval_start: string
  count: number
}

interface ClusteringHealthSnapshotRow {
  total_events: number
  clustered_events: number
  unclustered_events: number
  unique_templates: number
}

interface ClusteringHealthTrendRow {
  interval_start: string
  total: number
  unclustered: number
}

// -- Dashboard query option types --

interface DashboardTemplateOptions extends PaginationOptions {
  service?: string
  level?: string[]
}

interface DashboardVolumeOptions extends PaginationOptions {
  service?: string
  offset?: number
  level?: string[]
}

interface LevelDistributionRow {
  level: string
  count: number
}

// -- Query functions --

/**
 * Aggregates template_stats across time intervals (no interval_start in GROUP BY).
 * Returns top templates by occurrence count.
 */
export async function queryDashboardTemplates(
  db: DbClient,
  tenantId: string,
  options?: DashboardTemplateOptions,
): Promise<DashboardTemplateRow[]> {
  const limit = clamp(options?.limit ?? DEFAULT_STATS_LIMIT, MAX_STATS_LIMIT)
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const service = options?.service
  const levels = options?.level

  const serviceFilter = service ? 'AND service = {service:String}' : ''
  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT
    template_id,
    template_text,
    service,
    countMerge(occurrence_count)      AS occurrence_count,
    countIfMerge(error_count)         AS error_count,
    avgMerge(avg_duration_ms)         AS avg_duration_ms,
    maxMerge(max_anomaly_score)       AS max_anomaly_score,
    min(interval_start)               AS first_seen,
    max(interval_start)               AS last_seen
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
  ${serviceFilter}
  ${levelFilter}
GROUP BY template_id, template_text, service
ORDER BY occurrence_count DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { limit, hours }
  if (service) params.service = service
  if (levels?.length) params.levels = levels

  return db.query<DashboardTemplateRow>(tenantQuery(query, tenantId, params))
}

/**
 * Returns the set of template IDs that were first seen (is_new_template=1)
 * in the last 24 hours.
 */
export async function queryNewTodayIds(
  db: DbClient,
  tenantId: string,
  options?: { level?: string[] },
): Promise<string[]> {
  const levels = options?.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT DISTINCT template_id
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND template_id != '0'
  AND is_new_template = 1
  AND timestamp > now64(3) - toIntervalHour(24)
  ${levelFilter}`

  const params: Record<string, unknown> = {}
  if (levels?.length) params.levels = levels

  const rows = await db.query<NewTemplateIdRow>(tenantQuery(query, tenantId, params))
  return rows.map((r) => r.template_id)
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
    countIfMerge(error_count)         AS error_count,
    countIfMerge(warn_count)          AS warn_count,
    countIfMerge(new_template_count)  AS new_template_count,
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

  const query = `
SELECT
    interval_start,
    service,
    countMerge(log_count)     AS log_count,
    countIfMerge(error_count) AS error_count
FROM logweave.service_stats
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

/**
 * Aggregate counts from service_stats (single row).
 * Used for the dashboard overview panel.
 */
export async function queryDashboardOverviewAggregates(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { level?: string[] },
): Promise<OverviewAggregatesRow> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT
    countMerge(log_count)             AS total_events,
    countIfMerge(error_count)         AS error_count,
    countIfMerge(warn_count)          AS warn_count,
    countIfMerge(new_template_count)  AS new_template_count
FROM logweave.service_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}`

  const params: Record<string, unknown> = { hours }
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
  options?: Pick<PaginationOptions, 'hours'> & { level?: string[] },
): Promise<OverviewCountsRow> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT
    uniqIf(template_id, template_id != '0') AS unique_templates,
    countIf(template_id = '0')              AS unclustered_count,
    uniq(service)                           AS service_count
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}`

  const params: Record<string, unknown> = { hours }
  if (levels?.length) params.levels = levels

  const rows = await db.query<OverviewCountsRow>(tenantQuery(query, tenantId, params))
  return rows[0] ?? { unique_templates: 0, unclustered_count: 0, service_count: 0 }
}

/**
 * Per-template time series from template_stats.
 * Used for sparkline charts on the template list.
 */
export async function queryTemplateSparklines(
  db: DbClient,
  tenantId: string,
  options: { hours?: number; templateIds: string[]; level?: string[] },
): Promise<TemplateSparklineRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const templateIds = options.templateIds
  const levels = options.level

  if (templateIds.length === 0) return []

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT
    template_id,
    interval_start,
    countMerge(occurrence_count) AS count
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
  AND template_id IN ({template_ids:Array(String)})
  ${levelFilter}
GROUP BY template_id, interval_start
ORDER BY template_id, interval_start ASC`

  const params: Record<string, unknown> = { hours, template_ids: templateIds }
  if (levels?.length) params.levels = levels

  return db.query<TemplateSparklineRow>(tenantQuery(query, tenantId, params))
}

/**
 * Clustering health snapshot from log_metadata (single row).
 * Shows total vs clustered vs unclustered events.
 */
export async function queryClusteringHealthSnapshot(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { level?: string[] },
): Promise<ClusteringHealthSnapshotRow> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT
    count()                                         AS total_events,
    countIf(template_id != '0')                     AS clustered_events,
    countIf(template_id = '0')                      AS unclustered_events,
    uniqIf(template_id, template_id != '0')         AS unique_templates
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}`

  const params: Record<string, unknown> = { hours }
  if (levels?.length) params.levels = levels

  const rows = await db.query<ClusteringHealthSnapshotRow>(tenantQuery(query, tenantId, params))
  return (
    rows[0] ?? { total_events: 0, clustered_events: 0, unclustered_events: 0, unique_templates: 0 }
  )
}

/**
 * Clustering health over time from log_metadata.
 * Returns hourly buckets of total and unclustered event counts.
 */
export async function queryClusteringHealthTrend(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { level?: string[] },
): Promise<ClusteringHealthTrendRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT
    toStartOfHour(timestamp)    AS interval_start,
    count()                     AS total,
    countIf(template_id = '0')  AS unclustered
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}
GROUP BY interval_start
ORDER BY interval_start ASC`

  const params: Record<string, unknown> = { hours }
  if (levels?.length) params.levels = levels

  return db.query<ClusteringHealthTrendRow>(tenantQuery(query, tenantId, params))
}

/**
 * Level distribution from log_metadata.
 * Returns count of events per level for the given time window.
 */
export async function queryLevelDistribution(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { service?: string },
): Promise<LevelDistributionRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const service = options?.service

  const serviceFilter = service ? 'AND service = {service:String}' : ''

  const query = `
SELECT
    level,
    count() AS count
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
  ${serviceFilter}
GROUP BY level
ORDER BY count DESC`

  const params: Record<string, unknown> = { hours }
  if (service) params.service = service

  return db.query<LevelDistributionRow>(tenantQuery(query, tenantId, params))
}
