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
 * Minimum 5-min buckets required for a per-hour baseline to be considered
 * trustworthy. A single noisy bucket (e.g. a one-off late-night spike on
 * day 0 of a 7-day window) would otherwise become the official "baseline"
 * for that hour and silently swallow real anomalies on subsequent days.
 *
 * 3 buckets ≈ "this template fired at this hour on at least 3 distinct
 * days in the last week" (since same-hour-on-different-days produces
 * distinct 5-min interval_start values).
 */
const MIN_SAMPLES_PER_HOUR = 3

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
  template_id,
  service,
  toHour(interval_start) AS hour_of_day,
  countMerge(occurrence_count) / uniq(interval_start) AS avg_count_per_interval
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalDay({window_days:UInt32})
GROUP BY template_id, service, hour_of_day
HAVING uniq(interval_start) >= {min_samples:UInt32}
ORDER BY template_id, service, hour_of_day`

/**
 * Fetch the rolling 7-day baseline grouped by hour-of-day (UTC) for all
 * templates belonging to a tenant. One row per (template, service, hour).
 *
 * Returns avg 5-minute occurrence count. uniq(interval_start) — not count() —
 * because AggregatingMergeTree may hold multiple unmerged parts per bucket and
 * we want a per-bucket mean.
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
    }),
  )
}
