import type { DbClient } from './client.js'
import { clamp, DEFAULT_HOURS, MAX_HOURS, tenantQuery } from './queries.js'

// -- ClickHouse row interfaces (snake_case, matching query output) --

export interface NewTemplateRow {
  template_id: string
  template_text: string
  service: string
  occurrence_count: number
  error_count: number
  first_seen: string
}

export interface TemplateSpikeRow {
  template_id: string
  template_text: string
  service: string
  current_count: number
  previous_count: number
  spike_ratio: number
}

export interface ResolvedTemplateRow {
  template_id: string
  template_text: string
  service: string
  last_seen: string
  prev_count: number
}

// -- Query option types --

interface ChangesOptions {
  hours?: number
  service?: string
  limit?: number
  level?: string[]
}

interface SpikesOptions extends ChangesOptions {
  threshold?: number
}

const DEFAULT_CHANGES_LIMIT = 20
const MAX_CHANGES_LIMIT = 100

// -- Query functions --

/**
 * Returns templates first seen within the time window (is_new_template=1).
 */
export async function queryNewTemplates(
  db: DbClient,
  tenantId: string,
  options?: ChangesOptions,
): Promise<NewTemplateRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const limit = clamp(options?.limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)
  const service = options?.service
  const levels = options?.level

  const serviceFilter = service ? 'AND service = {service:String}' : ''
  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
SELECT
    template_id,
    any(template_text) AS template_text,
    any(service) AS service,
    count() AS occurrence_count,
    countIf(level = 'ERROR') AS error_count,
    min(timestamp) AS first_seen
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
  AND is_new_template = 1
  AND template_id != '0'
  ${serviceFilter}
  ${levelFilter}
GROUP BY template_id
ORDER BY occurrence_count DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { hours, limit }
  if (service) params.service = service
  if (levels?.length) params.levels = levels

  return db.query<NewTemplateRow>(tenantQuery(query, tenantId, params))
}

/**
 * Compares current window vs previous equivalent window.
 * Returns templates where current/previous > threshold (spike detection).
 */
export async function queryTemplateSpikes(
  db: DbClient,
  tenantId: string,
  options?: SpikesOptions,
): Promise<TemplateSpikeRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const limit = clamp(options?.limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)
  const threshold = Math.max(1, Math.min(100, options?.threshold ?? 3))
  const window = hours * 2
  const service = options?.service
  const levels = options?.level

  const serviceFilter = service ? 'AND service = {service:String}' : ''
  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
WITH
  current AS (
    SELECT template_id, any(template_text) AS template_text, any(service) AS service,
           countMerge(occurrence_count) AS cnt
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
      ${serviceFilter}
      ${levelFilter}
    GROUP BY template_id
  ),
  previous AS (
    SELECT template_id, countMerge(occurrence_count) AS cnt
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start > now64(3) - toIntervalHour({window:UInt32})
      AND interval_start <= now64(3) - toIntervalHour({hours:UInt32})
      ${serviceFilter}
      ${levelFilter}
    GROUP BY template_id
  )
SELECT
    c.template_id, c.template_text, c.service,
    c.cnt AS current_count,
    coalesce(p.cnt, 0) AS previous_count,
    if(coalesce(p.cnt, 0) > 0, CAST(c.cnt AS Float64) / p.cnt, 999) AS spike_ratio
FROM current c
LEFT JOIN previous p ON c.template_id = p.template_id
WHERE spike_ratio > {threshold:Float32}
ORDER BY spike_ratio DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { hours, limit, threshold, window }
  if (service) params.service = service
  if (levels?.length) params.levels = levels

  return db.query<TemplateSpikeRow>(tenantQuery(query, tenantId, params))
}

/**
 * Templates active in the previous window but absent in the current window.
 * Only considers templates with >= 5 occurrences in the previous window.
 */
export async function queryResolvedTemplates(
  db: DbClient,
  tenantId: string,
  options?: ChangesOptions,
): Promise<ResolvedTemplateRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const limit = clamp(options?.limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)
  const window = hours * 2
  const service = options?.service
  const levels = options?.level

  const serviceFilter = service ? 'AND service = {service:String}' : ''
  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
WITH
  current_ids AS (
    SELECT DISTINCT template_id
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
      ${serviceFilter}
      ${levelFilter}
  ),
  previous_active AS (
    SELECT template_id, any(template_text) AS template_text,
           any(service) AS service,
           max(interval_start) AS last_seen,
           countMerge(occurrence_count) AS prev_count
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start > now64(3) - toIntervalHour({window:UInt32})
      AND interval_start <= now64(3) - toIntervalHour({hours:UInt32})
      ${serviceFilter}
      ${levelFilter}
    GROUP BY template_id
    HAVING prev_count >= 5
  )
SELECT
    p.template_id, p.template_text, p.service,
    p.last_seen, p.prev_count
FROM previous_active p
LEFT JOIN current_ids c ON p.template_id = c.template_id
WHERE c.template_id IS NULL
ORDER BY p.prev_count DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { hours, limit, window }
  if (service) params.service = service
  if (levels?.length) params.levels = levels

  return db.query<ResolvedTemplateRow>(tenantQuery(query, tenantId, params))
}
