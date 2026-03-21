import type { DbClient } from './client.js'
import { DEFAULT_HOURS, MAX_HOURS, clamp, tenantQuery } from './queries.js'

// ---------------------------------------------------------------------------
// Row interfaces (ClickHouse returns strings — cast in route handler)
// ---------------------------------------------------------------------------

export interface TraceEventRow {
  service: string
  template_id: string
  template_text: string
  level: string
  timestamp: string
  status_code: string
  duration_ms: string
  route: string
}

export interface RelatedPatternRow {
  template_id: string
  template_text: string
  service: string
  co_occurrence_count: string
}

export interface CorrelationRow {
  template_id: string
  template_text: string
  coefficient: string
  occurrence_count: string
}

export interface ServiceOutlierRow {
  data_points: string
  baseline_mean: string
  baseline_stddev: string
  current_rate: string
  current_errors: string
  current_logs: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TRACE_EVENTS = 200
const MAX_MATCHING_TRACES = 1000
const DEFAULT_RELATED_LIMIT = 20
const MAX_RELATED_LIMIT = 100
const DEFAULT_CORRELATION_LIMIT = 10
const MAX_CORRELATION_LIMIT = 50
const MIN_CORRELATION = 0.7
const MAX_OUTLIER_HOURS = 168

// ---------------------------------------------------------------------------
// 1. Trace details — events sharing a trace_id
// ---------------------------------------------------------------------------

const TRACE_DETAILS_QUERY = `
SELECT
    service, template_id, template_text, level, timestamp,
    status_code, duration_ms, route
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND trace_id = {trace_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
ORDER BY timestamp ASC
LIMIT {limit:UInt32}`

export async function queryTraceDetails(
  db: DbClient,
  tenantId: string,
  options: { traceId: string; hours?: number },
): Promise<TraceEventRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)
  return db.query<TraceEventRow>(
    tenantQuery(TRACE_DETAILS_QUERY, tenantId, {
      trace_id: options.traceId,
      hours,
      limit: MAX_TRACE_EVENTS,
    }),
  )
}

// ---------------------------------------------------------------------------
// 2. Related patterns — templates co-occurring in same traces
// ---------------------------------------------------------------------------

const RELATED_PATTERNS_QUERY = `
WITH matching_traces AS (
    SELECT DISTINCT trace_id
    FROM logweave.log_metadata
    WHERE tenant_id = {tenant_id:String}
      AND template_id = {template_id:String}
      AND trace_id != ''
      AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
    LIMIT {max_traces:UInt32}
)
SELECT
    m.template_id,
    any(m.template_text)  AS template_text,
    any(m.service)        AS service,
    count()               AS co_occurrence_count
FROM logweave.log_metadata m
INNER JOIN matching_traces t ON m.trace_id = t.trace_id
WHERE m.tenant_id = {tenant_id:String}
  AND m.template_id != {template_id:String}
  AND m.template_id != '0'
  AND m.trace_id != ''
  AND m.timestamp > now64(3) - toIntervalHour({hours:UInt32})
GROUP BY m.template_id
ORDER BY co_occurrence_count DESC
LIMIT {limit:UInt32}`

export async function queryRelatedPatterns(
  db: DbClient,
  tenantId: string,
  options: { templateId: string; hours?: number; limit?: number },
): Promise<RelatedPatternRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const limit = clamp(options.limit ?? DEFAULT_RELATED_LIMIT, MAX_RELATED_LIMIT)
  return db.query<RelatedPatternRow>(
    tenantQuery(RELATED_PATTERNS_QUERY, tenantId, {
      template_id: options.templateId,
      hours,
      limit,
      max_traces: MAX_MATCHING_TRACES,
    }),
  )
}

// ---------------------------------------------------------------------------
// 3. Correlations — Pearson correlation of 5-min occurrence counts
// ---------------------------------------------------------------------------

const CORRELATIONS_QUERY = `
WITH
    anchor AS (
        SELECT interval_start, countMerge(occurrence_count) AS cnt
        FROM logweave.template_stats
        WHERE tenant_id = {tenant_id:String}
          AND template_id = {template_id:String}
          AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
        GROUP BY interval_start
    ),
    candidates AS (
        SELECT template_id, any(template_text) AS template_text,
               interval_start, countMerge(occurrence_count) AS cnt
        FROM logweave.template_stats
        WHERE tenant_id = {tenant_id:String}
          AND template_id != {template_id:String}
          AND template_id != '0'
          AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
        GROUP BY template_id, interval_start
    ),
    top_candidates AS (
        SELECT template_id
        FROM candidates
        GROUP BY template_id
        ORDER BY sum(cnt) DESC
        LIMIT 50
    )
SELECT
    c.template_id,
    any(c.template_text) AS template_text,
    corr(a.cnt, c.cnt)   AS coefficient,
    sum(c.cnt)            AS occurrence_count
FROM candidates c
INNER JOIN anchor a ON c.interval_start = a.interval_start
WHERE c.template_id IN (SELECT template_id FROM top_candidates)
GROUP BY c.template_id
HAVING abs(coefficient) >= {min_correlation:Float64} AND isFinite(coefficient)
ORDER BY abs(coefficient) DESC
LIMIT {limit:UInt32}`

export async function queryCorrelations(
  db: DbClient,
  tenantId: string,
  options: { templateId: string; hours?: number; limit?: number },
): Promise<CorrelationRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const limit = clamp(options.limit ?? DEFAULT_CORRELATION_LIMIT, MAX_CORRELATION_LIMIT)
  return db.query<CorrelationRow>(
    tenantQuery(CORRELATIONS_QUERY, tenantId, {
      template_id: options.templateId,
      hours,
      limit,
      min_correlation: MIN_CORRELATION,
    }),
  )
}

// ---------------------------------------------------------------------------
// 4. Service outlier — z-score of current error rate vs 7-day baseline
// ---------------------------------------------------------------------------

const SERVICE_OUTLIER_QUERY = `
WITH hourly AS (
    SELECT interval_start,
           countMerge(error_count) AS error_count,
           countMerge(log_count)   AS log_count
    FROM logweave.service_stats
    WHERE tenant_id = {tenant_id:String}
      AND service = {service:String}
      AND interval_start > now64(3) - toIntervalDay(7)
    GROUP BY interval_start
)
SELECT
    count()     AS data_points,
    avgIf(error_count, interval_start <= now64(3) - toIntervalHour({hours:UInt32}))
                AS baseline_mean,
    stddevPopIf(error_count, interval_start <= now64(3) - toIntervalHour({hours:UInt32}))
                AS baseline_stddev,
    avgIf(error_count, interval_start > now64(3) - toIntervalHour({hours:UInt32}))
                AS current_rate,
    sumIf(error_count, interval_start > now64(3) - toIntervalHour({hours:UInt32}))
                AS current_errors,
    sumIf(log_count, interval_start > now64(3) - toIntervalHour({hours:UInt32}))
                AS current_logs
FROM hourly`

export async function queryServiceOutlier(
  db: DbClient,
  tenantId: string,
  options: { service: string; hours?: number },
): Promise<ServiceOutlierRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_OUTLIER_HOURS)
  return db.query<ServiceOutlierRow>(
    tenantQuery(SERVICE_OUTLIER_QUERY, tenantId, {
      service: options.service,
      hours,
    }),
  )
}
