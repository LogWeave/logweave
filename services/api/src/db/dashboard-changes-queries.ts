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
  since?: string
  service?: string
  limit?: number
  level?: string[]
}

const DEFAULT_SPIKE_MIN_BASELINE = 10

interface SpikesOptions extends ChangesOptions {
  threshold?: number
  minBaseline?: number
}

const DEFAULT_CHANGES_LIMIT = 20
const MAX_CHANGES_LIMIT = 100

// -- Time window computation for since-based queries --

interface TimeWindow {
  currentStart: string
  currentEnd: string
  previousStart: string
  previousEnd: string
}

/**
 * Computes absolute time windows from a `since` timestamp.
 * Current = [since, now], Previous = [since - duration, since]
 * where duration = now - since.
 */
export function computeTimeWindow(since: string): TimeWindow {
  const now = new Date()
  const sinceDate = new Date(since)
  const durationMs = now.getTime() - sinceDate.getTime()
  return {
    currentStart: sinceDate.toISOString(),
    currentEnd: now.toISOString(),
    previousStart: new Date(sinceDate.getTime() - durationMs).toISOString(),
    previousEnd: sinceDate.toISOString(),
  }
}

/**
 * Convert ISO 8601 timestamp to ClickHouse DateTime64(3) format.
 * ClickHouse parameterized queries with DateTime64(3) type reject
 * 'T' separators and 'Z' suffixes.
 */
export function toClickHouseDateTime(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '')
}

// -- Shared filter builders --

function buildFilters(service?: string, levels?: string[]) {
  return {
    serviceFilter: service ? 'AND service = {service:String}' : '',
    levelFilter: levels?.length ? 'AND level IN ({levels:Array(String)})' : '',
  }
}

function addFilterParams(params: Record<string, unknown>, service?: string, levels?: string[]) {
  if (service) params.service = service
  if (levels?.length) params.levels = levels
}

// -- Query functions --

/**
 * Returns templates first seen within the time window.
 *
 * hours-path: queries log_metadata with is_new_template=1 flag.
 * since-path: queries template_stats with set-difference (templates in current
 *   window minus templates in previous window). Cannot use is_new_template because
 *   that flag is relative to Drain3's global state, not the since timestamp.
 */
export async function queryNewTemplates(
  db: DbClient,
  tenantId: string,
  options?: ChangesOptions,
): Promise<NewTemplateRow[]> {
  const limit = clamp(options?.limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)
  const service = options?.service
  const levels = options?.level
  const { serviceFilter, levelFilter } = buildFilters(service, levels)

  if (options?.since) {
    const tw = computeTimeWindow(options.since)

    const query = `
WITH
  current_active AS (
    SELECT template_id, any(template_text) AS template_text,
           any(service) AS service_name,
           countMerge(occurrence_count) AS occurrence_count,
           countMerge(error_count) AS error_count,
           min(interval_start) AS first_seen
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start >= {current_start:DateTime64(3)}
      AND interval_start <= {current_end:DateTime64(3)}
      ${serviceFilter}
      ${levelFilter}
    GROUP BY template_id
  ),
  previous_ids AS (
    SELECT DISTINCT template_id
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start >= {previous_start:DateTime64(3)}
      AND interval_start < {previous_end:DateTime64(3)}
      ${serviceFilter}
      ${levelFilter}
  )
SELECT
    c.template_id, c.template_text, c.service_name AS service,
    c.occurrence_count, c.error_count, c.first_seen
FROM current_active c
LEFT JOIN previous_ids p ON c.template_id = p.template_id
WHERE p.template_id IS NULL
ORDER BY c.occurrence_count DESC
LIMIT {limit:UInt32}`

    const params: Record<string, unknown> = {
      limit,
      current_start: toClickHouseDateTime(tw.currentStart),
      current_end: toClickHouseDateTime(tw.currentEnd),
      previous_start: toClickHouseDateTime(tw.previousStart),
      previous_end: toClickHouseDateTime(tw.previousEnd),
    }
    addFilterParams(params, service, levels)
    return db.query<NewTemplateRow>(tenantQuery(query, tenantId, params))
  }

  // -- hours-based path (existing behavior) --
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)

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
  addFilterParams(params, service, levels)
  return db.query<NewTemplateRow>(tenantQuery(query, tenantId, params))
}

/**
 * Compares current window vs previous equivalent window.
 * Returns templates where current/previous > threshold (spike detection).
 *
 * hours-path: relative offsets from now64(3).
 * since-path: absolute timestamps from computeTimeWindow.
 */
export async function queryTemplateSpikes(
  db: DbClient,
  tenantId: string,
  options?: SpikesOptions,
): Promise<TemplateSpikeRow[]> {
  const limit = clamp(options?.limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)
  const threshold = Math.max(1, Math.min(100, options?.threshold ?? 3))
  const minBaseline = Math.max(0, options?.minBaseline ?? DEFAULT_SPIKE_MIN_BASELINE)
  const service = options?.service
  const levels = options?.level
  const { serviceFilter, levelFilter } = buildFilters(service, levels)

  if (options?.since) {
    const tw = computeTimeWindow(options.since)

    const query = `
WITH
  current AS (
    SELECT template_id, any(template_text) AS template_text, any(service) AS service_name,
           countMerge(occurrence_count) AS cnt
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start >= {current_start:DateTime64(3)}
      AND interval_start <= {current_end:DateTime64(3)}
      ${serviceFilter}
      ${levelFilter}
    GROUP BY template_id
  ),
  previous AS (
    SELECT template_id, countMerge(occurrence_count) AS cnt
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start >= {previous_start:DateTime64(3)}
      AND interval_start < {previous_end:DateTime64(3)}
      ${serviceFilter}
      ${levelFilter}
    GROUP BY template_id
  )
SELECT
    c.template_id, c.template_text, c.service_name AS service,
    c.cnt AS current_count,
    coalesce(p.cnt, 0) AS previous_count,
    if(coalesce(p.cnt, 0) > 0, CAST(c.cnt AS Float64) / p.cnt, 999) AS spike_ratio
FROM current c
LEFT JOIN previous p ON c.template_id = p.template_id
WHERE spike_ratio > {threshold:Float32}
  AND previous_count >= {min_baseline:UInt32}
ORDER BY spike_ratio DESC
LIMIT {limit:UInt32}`

    const params: Record<string, unknown> = {
      limit,
      threshold,
      min_baseline: minBaseline,
      current_start: toClickHouseDateTime(tw.currentStart),
      current_end: toClickHouseDateTime(tw.currentEnd),
      previous_start: toClickHouseDateTime(tw.previousStart),
      previous_end: toClickHouseDateTime(tw.previousEnd),
    }
    addFilterParams(params, service, levels)
    return db.query<TemplateSpikeRow>(tenantQuery(query, tenantId, params))
  }

  // -- hours-based path (existing behavior) --
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const window = hours * 2

  const query = `
WITH
  current AS (
    SELECT template_id, any(template_text) AS template_text, any(service) AS service_name,
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
    c.template_id, c.template_text, c.service_name AS service,
    c.cnt AS current_count,
    coalesce(p.cnt, 0) AS previous_count,
    if(coalesce(p.cnt, 0) > 0, CAST(c.cnt AS Float64) / p.cnt, 999) AS spike_ratio
FROM current c
LEFT JOIN previous p ON c.template_id = p.template_id
WHERE spike_ratio > {threshold:Float32}
  AND previous_count >= {min_baseline:UInt32}
ORDER BY spike_ratio DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { hours, limit, threshold, min_baseline: minBaseline, window }
  addFilterParams(params, service, levels)
  return db.query<TemplateSpikeRow>(tenantQuery(query, tenantId, params))
}

/**
 * Templates active in the previous window but absent in the current window.
 * Only considers templates with >= 5 occurrences in the previous window.
 *
 * hours-path: relative offsets from now64(3).
 * since-path: absolute timestamps from computeTimeWindow.
 */
export async function queryResolvedTemplates(
  db: DbClient,
  tenantId: string,
  options?: ChangesOptions,
): Promise<ResolvedTemplateRow[]> {
  const limit = clamp(options?.limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)
  const service = options?.service
  const levels = options?.level
  const { serviceFilter, levelFilter } = buildFilters(service, levels)

  if (options?.since) {
    const tw = computeTimeWindow(options.since)

    const query = `
WITH
  current_ids AS (
    SELECT DISTINCT template_id
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start >= {current_start:DateTime64(3)}
      AND interval_start <= {current_end:DateTime64(3)}
      ${serviceFilter}
      ${levelFilter}
  ),
  previous_active AS (
    SELECT template_id, any(template_text) AS template_text,
           any(service) AS service_name,
           max(interval_start) AS last_seen,
           countMerge(occurrence_count) AS prev_count
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start >= {previous_start:DateTime64(3)}
      AND interval_start < {previous_end:DateTime64(3)}
      ${serviceFilter}
      ${levelFilter}
    GROUP BY template_id
    HAVING prev_count >= 5
  )
SELECT
    p.template_id, p.template_text, p.service_name AS service,
    p.last_seen, p.prev_count
FROM previous_active p
LEFT JOIN current_ids c ON p.template_id = c.template_id
WHERE c.template_id IS NULL
ORDER BY p.prev_count DESC
LIMIT {limit:UInt32}`

    const params: Record<string, unknown> = {
      limit,
      current_start: toClickHouseDateTime(tw.currentStart),
      current_end: toClickHouseDateTime(tw.currentEnd),
      previous_start: toClickHouseDateTime(tw.previousStart),
      previous_end: toClickHouseDateTime(tw.previousEnd),
    }
    addFilterParams(params, service, levels)
    return db.query<ResolvedTemplateRow>(tenantQuery(query, tenantId, params))
  }

  // -- hours-based path (existing behavior) --
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const window = hours * 2

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
           any(service) AS service_name,
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
    p.template_id, p.template_text, p.service_name AS service,
    p.last_seen, p.prev_count
FROM previous_active p
LEFT JOIN current_ids c ON p.template_id = c.template_id
WHERE c.template_id IS NULL
ORDER BY p.prev_count DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { hours, limit, window }
  addFilterParams(params, service, levels)
  return db.query<ResolvedTemplateRow>(tenantQuery(query, tenantId, params))
}
