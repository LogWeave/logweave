import type { DbClient } from './client.js'
import { clamp, DEFAULT_HOURS, MAX_HOURS, tenantQuery } from './queries.js'

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
  service: string
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
// Outlier "current window" cap. The z-score baseline is matched to the current
// hour-of-day (see SERVICE_OUTLIER_QUERY); a wide current window defeats that —
// it averages current_rate across many hours-of-day (re-mixing the diurnal
// cycle the baseline removes) and, past 7 days, makes the baseline window
// (interval_start > now-7d) disjoint from the baseline filter
// (interval_start <= now-{hours}) so data_points collapses to 0. Keep the
// current window near a single hour-of-day. (Chunk 5 / #258)
const MAX_OUTLIER_HOURS = 6

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

/*
 * Pearson correlation of 5-min bucket occurrence counts across the window,
 * de-seasonalized by hour-of-day (Chunk 5 / #258).
 *
 * Correctness traps handled:
 *
 *   1. (#220) INNER JOINing candidate buckets to anchor buckets drops every
 *      5-min slot where the candidate didn't fire — Pearson then sees only
 *      co-occurring buckets and trivially returns r≈1. We build a complete
 *      bucket grid and LEFT JOIN with coalesce(cnt, 0) so absent buckets count
 *      as real zeros. candidate_full carries the candidate id (`tc.template_id`)
 *      for those zero buckets so they survive into the correlation.
 *
 *   2. (#258) Without de-seasonalization, two unrelated templates that both
 *      track the daily traffic cycle correlate spuriously. We correlate the
 *      *residuals* — each bucket minus that series' mean for its hour-of-day
 *      (UTC) — so a match means "moves together beyond the normal daily
 *      rhythm", not "both busy at noon". Note this suppresses *purely* diurnal
 *      candidates (flat within each hour → residual 0 → corr is NaN → filtered);
 *      a candidate that also genuinely co-moves with the anchor *within* the
 *      hour will still correlate, which is the intended behaviour, not a leak.
 *
 *   3. corr() over too few points is meaningless (returns 1 or NaN). The
 *      >= MIN_OBSERVATIONS guard rejects thin windows, and the
 *      >= MIN_COOCCURRENCE guard requires a floor of buckets where BOTH fired
 *      so a pair that barely overlaps can't produce signal.
 *
 * The grid is generated by arrayJoin(range(N)) where N = hours * 12 buckets/hr,
 * anchored at floor(now / 5min) — same bucketing as template_stats's
 * toStartOfFiveMinutes() materialization.
 */
const CORRELATIONS_QUERY = `
WITH
    grid AS (
        SELECT
            toStartOfFiveMinutes(now64(3)) - toIntervalMinute(5 * (arrayJoin(range({bucket_count:UInt32})) + 1)) AS bucket_start
    ),
    anchor AS (
        SELECT toStartOfFiveMinutes(interval_start) AS bucket_start,
               countMerge(occurrence_count) AS cnt
        FROM logweave.template_stats
        WHERE tenant_id = {tenant_id:String}
          AND template_id = {template_id:String}
          AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
        GROUP BY bucket_start
    ),
    anchor_full AS (
        SELECT g.bucket_start AS bucket_start, coalesce(a.cnt, 0) AS cnt
        FROM grid g
        LEFT JOIN anchor a ON g.bucket_start = a.bucket_start
    ),
    anchor_resid AS (
        SELECT bucket_start,
               cnt,
               cnt - avg(cnt) OVER (PARTITION BY toHour(bucket_start)) AS resid
        FROM anchor_full
    ),
    candidate_buckets AS (
        SELECT template_id,
               any(template_text) AS template_text,
               any(service) AS service,
               toStartOfFiveMinutes(interval_start) AS bucket_start,
               countMerge(occurrence_count) AS cnt
        FROM logweave.template_stats
        WHERE tenant_id = {tenant_id:String}
          AND template_id != {template_id:String}
          AND template_id != '0'
          AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
        GROUP BY template_id, bucket_start
    ),
    candidate_meta AS (
        SELECT template_id,
               any(template_text) AS template_text,
               any(service) AS service
        FROM candidate_buckets
        GROUP BY template_id
    ),
    top_candidates AS (
        SELECT template_id
        FROM candidate_buckets
        GROUP BY template_id
        ORDER BY sum(cnt) DESC
        LIMIT 50
    ),
    candidate_full AS (
        SELECT tc.template_id AS template_id,
               g.bucket_start AS bucket_start,
               coalesce(cb.cnt, 0) AS cnt
        FROM (SELECT template_id FROM top_candidates) tc
        CROSS JOIN grid g
        LEFT JOIN candidate_buckets cb
            ON cb.template_id = tc.template_id AND cb.bucket_start = g.bucket_start
    ),
    candidate_resid AS (
        SELECT template_id,
               bucket_start,
               cnt,
               cnt - avg(cnt) OVER (PARTITION BY template_id, toHour(bucket_start)) AS resid
        FROM candidate_full
    )
SELECT
    cf.template_id      AS template_id,
    any(cm.template_text) AS template_text,
    any(cm.service)     AS service,
    corr(af.resid, cf.resid) AS coefficient,
    sum(cf.cnt)         AS occurrence_count
FROM candidate_resid cf
INNER JOIN anchor_resid af ON cf.bucket_start = af.bucket_start
INNER JOIN candidate_meta cm ON cm.template_id = cf.template_id
GROUP BY cf.template_id
HAVING count() >= {min_observations:UInt32}
  AND countIf(af.cnt > 0 AND cf.cnt > 0) >= {min_cooccurrence:UInt32}
  AND abs(coefficient) >= {min_correlation:Float64}
  AND isFinite(coefficient)
ORDER BY abs(coefficient) DESC
LIMIT {limit:UInt32}`

const MIN_OBSERVATIONS = 6
// Minimum 5-min buckets where BOTH templates fired. A pair that overlaps in
// only a handful of buckets can't produce a trustworthy correlation even after
// de-seasonalization. (Chunk 5 / #258)
const MIN_COOCCURRENCE = 3

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
      bucket_count: hours * 12, // 12 five-minute buckets per hour
      limit,
      min_correlation: MIN_CORRELATION,
      min_observations: MIN_OBSERVATIONS,
      min_cooccurrence: MIN_COOCCURRENCE,
    }),
  )
}

// ---------------------------------------------------------------------------
// 4. Service outlier — z-score of current error rate vs same-hour-of-day baseline
// ---------------------------------------------------------------------------

/*
 * Hour-of-day-matched z-score (Chunk 5 / #258). The baseline mean/stddev are
 * computed only from the SAME hour-of-day (UTC) as the current window over the
 * last 7 days, so an off-peak spike is compared against the off-peak norm — not
 * a flat all-day average inflated by daytime traffic. This mirrors the
 * diurnal-aware approach ADR-014 chose for the ingest scorer.
 *
 * `service_stats` is hourly (toStartOfHour), so each baseline sample is one
 * day's value at that hour-of-day → ~7 samples over the window. The baseline
 * excludes the current window (interval_start <= now - {hours}) so "now" never
 * contaminates its own baseline. data_points reports the baseline sample count
 * (number of historical days at this hour-of-day), which the caller gates on.
 */
const SERVICE_OUTLIER_QUERY = `
WITH
    toHour(now64(3)) AS current_hod,
    hourly AS (
        SELECT interval_start,
               toHour(interval_start)  AS hod,
               countMerge(error_count) AS error_count,
               countMerge(log_count)   AS log_count
        FROM logweave.service_stats
        WHERE tenant_id = {tenant_id:String}
          AND service = {service:String}
          AND interval_start > now64(3) - toIntervalDay(7)
        GROUP BY interval_start
    )
SELECT
    countIf(hod = current_hod AND interval_start <= now64(3) - toIntervalHour({hours:UInt32}))
                AS data_points,
    avgIf(error_count, hod = current_hod AND interval_start <= now64(3) - toIntervalHour({hours:UInt32}))
                AS baseline_mean,
    stddevPopIf(error_count, hod = current_hod AND interval_start <= now64(3) - toIntervalHour({hours:UInt32}))
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
