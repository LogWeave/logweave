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

// Row interfaces stay snake_case to match raw ClickHouse JSONEachRow output;
// route handlers convert to camelCase via mapping helpers.

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

interface TemplateSparklineRow {
  template_id: string
  interval_start: string
  count: number
}

export interface CrossServiceTemplateRow {
  template_id: string
  template_text: string
  services_affected: string[]
  occurrence_count: number
  error_count: number
  avg_duration_ms: number
  max_anomaly_score: number
  first_seen: string
  last_seen: string
}

interface DashboardTemplateOptions extends PaginationOptions {
  service?: string
  level?: string[]
  templateId?: string
}

/**
 * Aggregates template_stats across time intervals AND services.
 * Returns top templates with a servicesAffected array per template.
 * Used by MCP/API consumers that need cross-service blast radius.
 */
export async function queryTemplatesAcrossServices(
  db: DbClient,
  tenantId: string,
  options?: DashboardTemplateOptions,
): Promise<CrossServiceTemplateRow[]> {
  const limit = clamp(options?.limit ?? DEFAULT_STATS_LIMIT, MAX_STATS_LIMIT)
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const service = options?.service
  const levels = options?.level
  const templateId = options?.templateId

  const serviceFilter = service ? 'AND service = {service:String}' : ''
  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''
  const templateFilter = templateId ? 'AND template_id = {template_id:String}' : ''

  const query = `
/* @query: templatesAcrossServices */
SELECT
    template_id,
    template_text,
    groupArray(DISTINCT service)      AS services_affected,
    countMerge(occurrence_count)      AS occurrence_count,
    countMerge(error_count)         AS error_count,
    avgMerge(avg_duration_ms)         AS avg_duration_ms,
    maxMerge(max_anomaly_score)       AS max_anomaly_score,
    min(interval_start)               AS first_seen,
    max(interval_start)               AS last_seen
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
  ${serviceFilter}
  ${levelFilter}
  ${templateFilter}
GROUP BY template_id, template_text
ORDER BY occurrence_count DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { limit, hours }
  if (service) params.service = service
  if (templateId) params.template_id = templateId
  if (levels?.length) params.levels = levels

  return db.query<CrossServiceTemplateRow>(tenantQuery(query, tenantId, params))
}

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
/* @query: dashboardTemplates */
SELECT
    template_id,
    template_text,
    service,
    countMerge(occurrence_count)      AS occurrence_count,
    countMerge(error_count)         AS error_count,
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
/* @query: newTodayIds */
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
 * Per-template time series from template_stats.
 * Used for sparkline charts on the template list.
 */
export async function queryTemplateSparklines(
  db: DbClient,
  tenantId: string,
  options: { hours?: number; templateIds: string[]; level?: string[] },
): Promise<TemplateSparklineRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)
  // Cap caller-supplied template_ids to bound the IN-list and the result
  // set. 500 sparklines is well beyond any realistic dashboard render.
  const templateIds = options.templateIds.slice(0, 500)
  const levels = options.level

  if (templateIds.length === 0) return []

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
/* @query: templateSparklines */
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
ORDER BY template_id, interval_start ASC
LIMIT 50000`

  const params: Record<string, unknown> = { hours, template_ids: templateIds }
  if (levels?.length) params.levels = levels

  return db.query<TemplateSparklineRow>(tenantQuery(query, tenantId, params))
}
