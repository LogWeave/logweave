import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

export interface BaselineRow {
  template_id: string
  service: string
  /** UTC hour-of-day [0,23] this baseline row applies to. */
  hour_of_day: number
  /** Average 5-minute occurrence count for this template+service at this hour. */
  avg_count_per_interval: number
}

/**
 * Anomaly baseline window. See ADR-014. Exported so tests assert against the
 * constant rather than substring-matching SQL, and so the value is visible at
 * call sites that reason about the baseline horizon.
 */
export const BASELINE_WINDOW_DAYS = 7

/**
 * Minimum distinct *days* required for a per-hour baseline to be considered
 * trustworthy. A single noisy day (e.g. a one-off late-night spike on day 0
 * of a 7-day window) would otherwise become the official "baseline" for that
 * hour and silently swallow real anomalies on subsequent days.
 *
 * Counted as `uniq(toDate(interval_start))` — distinct calendar days the
 * template fired at this hour-of-day. NOT `uniq(interval_start)`: three
 * firings within a single hour on one day produce three distinct 5-min
 * timestamps, which would wrongly satisfy a buckets-based guard with only one
 * day of data. See ADR-014.
 */
const MIN_SAMPLES_PER_HOUR = 3

/** Five-minute buckets per hour — the per-interval denominator for a full hour. */
const BUCKETS_PER_HOUR = 12

/**
 * High-water mark for warning when a tenant's row count approaches a level
 * that suggests the query is doing unbounded work. No LIMIT clause — the
 * row count is bounded by template × service × 24-hour cardinality, which
 * is a small number per realistic tenant. ORDER BY is deterministic so
 * tests can rely on row order.
 */
export const BASELINE_ROW_WARN_THRESHOLD = 100_000

const BASELINE_QUERY = `
SELECT
  hourly.template_id AS template_id,
  hourly.service AS service,
  hourly.hour_of_day AS hour_of_day,
  hourly.occurrences / (active.active_days * {buckets_per_hour:UInt32}) AS avg_count_per_interval
FROM (
  SELECT
    template_id,
    service,
    toHour(interval_start) AS hour_of_day,
    countMerge(occurrence_count) AS occurrences
  FROM logweave.template_stats
  WHERE tenant_id = {tenant_id:String}
    AND interval_start > now64(3) - toIntervalDay({window_days:UInt32})
  GROUP BY template_id, service, hour_of_day
  HAVING uniq(toDate(interval_start)) >= {min_samples:UInt32}
) AS hourly
INNER JOIN (
  SELECT
    template_id,
    service,
    uniq(toDate(interval_start)) AS active_days
  FROM logweave.template_stats
  WHERE tenant_id = {tenant_id:String}
    AND interval_start > now64(3) - toIntervalDay({window_days:UInt32})
  GROUP BY template_id, service
) AS active ON hourly.template_id = active.template_id AND hourly.service = active.service
ORDER BY template_id, service, hour_of_day`

/**
 * Fetch the rolling 7-day baseline grouped by hour-of-day (UTC) for all
 * templates belonging to a tenant. One row per (template, service, hour).
 *
 * Returns the true per-interval rate: total occurrences at the hour-of-day
 * divided by the number of 5-min buckets it *could* have had over the window —
 * `active_days × 12`, where `active_days` is the distinct calendar days the
 * template+service logged anything at any hour. So a day the template was alive
 * but silent at this hour counts as the zeros it is, while days before the
 * template first appeared are not charged against it.
 *
 * Crucially this is NOT the per-hour firing-day count
 * (`uniq(toDate(interval_start))` inside the hour group): that only counts days
 * the template fired *at this hour*, dropping whole days it was silent here and
 * overstating "normal" for sparse/bursty templates (~2.3× for a 3-of-7-day
 * pattern) — which suppresses real spikes. Nor `uniq(interval_start)` (buckets
 * that fired), a conditional "how much when it fires" mean. See ADR-014.
 *
 * No FINAL needed: -Merge combinators re-aggregate partial states from unmerged
 * parts, and GROUP BY collapses them. Adding FINAL would hurt performance with
 * no correctness benefit on AggregatingMergeTree.
 */
export async function queryAnomalyBaselines(
  db: DbClient,
  tenantId: string,
): Promise<BaselineRow[]> {
  return db.query<BaselineRow>(
    tenantQuery(BASELINE_QUERY, tenantId, {
      window_days: BASELINE_WINDOW_DAYS,
      min_samples: MIN_SAMPLES_PER_HOUR,
      buckets_per_hour: BUCKETS_PER_HOUR,
    }),
  )
}
