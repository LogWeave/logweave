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

/**
 * Event count below which the previous window is considered too thin for a
 * meaningful spike comparison. Surfaces as `meta.baselineStatus: 'sparse'` so
 * the UI can tell users the panel's results may be incomplete.
 *
 * 50 events ≈ ~5 events per minute over a 10-minute window. Below that the
 * spike-ratio numerator (current count) easily dominates and produces alarm-
 * looking ratios from a handful of legitimate events.
 */
const SPARSE_BASELINE_THRESHOLD = 50

export type BaselineStatus = 'empty' | 'sparse' | 'ok'

export interface BaselineSnapshot {
  status: BaselineStatus
  previousWindowEvents: number
  /**
   * ISO timestamp of the earliest `template_stats` bucket for the tenant
   * (across all services). Lets the dashboard compute "comparison ready in
   * ~N minutes" instead of just showing static empty-baseline copy. Returns
   * null when the tenant has never ingested.
   */
  tenantFirstSeenAt: string | null
}

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
function toClickHouseDateTime(iso: string): string {
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
 * Returns templates active in the current time window but absent in the
 * equivalent previous window — i.e. "new to this window".
 *
 * Both paths use set-difference on template_stats. The hours-path used to filter
 * log_metadata on is_new_template=1 (a Drain3-global "first ever seen" flag) but
 * that fires once per template lifetime; templates dormant for hours and then
 * surging were never surfaced. See issue #218.
 *
 * Note on bucketing: template_stats buckets by toStartOfFiveMinutes(timestamp),
 * so events from the trailing partial bucket are included in the window. This is
 * consistent with how the spike and resolved queries treat windows; differs
 * slightly from log_metadata's per-event resolution but the divergence is < 5min.
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
/* @query: newTemplates */
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

  // -- hours-based path: set-difference on template_stats (mirrors since-path) --
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const window = hours * 2

  const query = `
/* @query: newTemplates */
WITH
  current_active AS (
    SELECT template_id, any(template_text) AS template_text,
           any(service) AS service_name,
           countMerge(occurrence_count) AS occurrence_count,
           countMerge(error_count) AS error_count,
           min(interval_start) AS first_seen
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
      ${serviceFilter}
      ${levelFilter}
    GROUP BY template_id
  ),
  previous_ids AS (
    SELECT DISTINCT template_id
    FROM logweave.template_stats
    WHERE tenant_id = {tenant_id:String}
      AND interval_start > now64(3) - toIntervalHour({window:UInt32})
      AND interval_start <= now64(3) - toIntervalHour({hours:UInt32})
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

  const params: Record<string, unknown> = { hours, limit, window }
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
/* @query: templateSpikes */
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
    p.cnt AS previous_count,
    CAST(c.cnt AS Float64) / p.cnt AS spike_ratio
FROM current c
INNER JOIN previous p ON c.template_id = p.template_id
WHERE p.cnt >= greatest({min_baseline:UInt32}, 1)
  AND spike_ratio > {threshold:Float32}
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
/* @query: templateSpikes */
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
    p.cnt AS previous_count,
    CAST(c.cnt AS Float64) / p.cnt AS spike_ratio
FROM current c
INNER JOIN previous p ON c.template_id = p.template_id
WHERE p.cnt >= greatest({min_baseline:UInt32}, 1)
  AND spike_ratio > {threshold:Float32}
ORDER BY spike_ratio DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = {
    hours,
    limit,
    threshold,
    min_baseline: minBaseline,
    window,
  }
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
/* @query: resolvedTemplates */
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
/* @query: resolvedTemplates */
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

/**
 * Total event count in the previous (baseline) comparison window.
 *
 * The spike query needs prior-window data to produce a ratio; the new/resolved
 * queries need it to detect set-difference. When the tenant has been ingesting
 * for less than 2× the lookback period (common on fresh installs), the previous
 * window is empty and all three buckets silently return zero rows. Surfacing
 * this count lets the API tell the client to render an honest "no baseline"
 * state instead of a misleading "all quiet."
 *
 * Returns 'empty' when the previous window has zero events, 'sparse' when it
 * has < SPARSE_BASELINE_THRESHOLD, otherwise 'ok'.
 */
export async function queryBaselineSnapshot(
  db: DbClient,
  tenantId: string,
  options?: ChangesOptions,
): Promise<BaselineSnapshot> {
  const service = options?.service
  const levels = options?.level
  const { serviceFilter, levelFilter } = buildFilters(service, levels)

  let query: string
  const params: Record<string, unknown> = {}

  if (options?.since) {
    const tw = computeTimeWindow(options.since)
    query = `
/* @query: baselineSnapshot */
SELECT countMerge(occurrence_count) AS prev_events
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start >= {previous_start:DateTime64(3)}
  AND interval_start < {previous_end:DateTime64(3)}
  ${serviceFilter}
  ${levelFilter}`
    params.previous_start = toClickHouseDateTime(tw.previousStart)
    params.previous_end = toClickHouseDateTime(tw.previousEnd)
  } else {
    const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
    const window = hours * 2
    query = `
/* @query: baselineSnapshot */
SELECT countMerge(occurrence_count) AS prev_events
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({window:UInt32})
  AND interval_start <= now64(3) - toIntervalHour({hours:UInt32})
  ${serviceFilter}
  ${levelFilter}`
    params.hours = hours
    params.window = window
  }
  addFilterParams(params, service, levels)

  const rows = await db.query<{ prev_events: number | string }>(
    tenantQuery(query, tenantId, params),
  )
  const previousWindowEvents = Number(rows[0]?.prev_events ?? 0)

  let status: BaselineStatus
  if (previousWindowEvents === 0) status = 'empty'
  else if (previousWindowEvents < SPARSE_BASELINE_THRESHOLD) status = 'sparse'
  else status = 'ok'

  const tenantFirstSeenAt = await queryTenantFirstSeenAt(db, tenantId)

  return { status, previousWindowEvents, tenantFirstSeenAt }
}

/**
 * ISO timestamp of the earliest template_stats bucket for the tenant, across
 * all services. Returns null if the tenant has never ingested. Used by the
 * What Changed panel to estimate how long until a comparison window is ready.
 *
 * Cheap: single MIN aggregate against the (tenant_id, service, interval_start)
 * primary key order — ClickHouse short-circuits to the first matching part.
 */
async function queryTenantFirstSeenAt(
  db: DbClient,
  tenantId: string,
): Promise<string | null> {
  const rows = await db.query<{ first_seen: string }>(
    tenantQuery(
      `/* @query: tenantFirstSeenAt */
SELECT min(interval_start) AS first_seen
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}`,
      tenantId,
      {},
    ),
  )
  const raw = rows[0]?.first_seen
  if (!raw) return null
  // ClickHouse returns DateTime64 as 'YYYY-MM-DD HH:MM:SS.mmm' — guard the
  // zero-date case (no rows -> '1970-01-01 00:00:00.000') which means tenant
  // has nothing.
  if (raw.startsWith('1970-')) return null
  return new Date(`${raw.replace(' ', 'T')}Z`).toISOString()
}
