# ADR-014: Anomaly Baseline Window — 7d, Hour-of-Day Matched

**Status:** Accepted
**Date:** 2026-05-23
**Issue:** [#203](https://github.com/RobertDicker/logweave/issues/203)

## Context

The original anomaly scorer used a **rolling 1-hour baseline**:

```sql
SELECT countMerge(occurrence_count) / uniq(interval_start) AS avg_count_per_interval
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour(1)
GROUP BY template_id, service
```

A maintainability/lemon-test review flagged three statistical problems with a 1-hour window:

1. **Spike absorption** — a pattern that spikes once and stays elevated looks anomalous for ~1 hour, then alerts stop because the spike *becomes* the baseline.
2. **Tiny denominator for rare patterns** — 12 five-minute buckets is not enough samples for low-rate templates; variance dominates signal.
3. **No diurnal handling** — 3 AM and 3 PM both look like "now". A site with normal daily seasonality alerts on every quiet hour.

## Decision

Move to a **7-day window grouped by hour-of-day** (UTC). Each baseline row is the average 5-minute occurrence count for a `(template_id, service, hourOfDay)` over the last 7 days, **provided at least 3 distinct 5-min buckets contributed to the average**.

```sql
SELECT
  template_id,
  service,
  toHour(interval_start) AS hour_of_day,
  countMerge(occurrence_count) / uniq(interval_start) AS avg_count_per_interval
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalDay(7)
GROUP BY template_id, service, hour_of_day
HAVING uniq(interval_start) >= 3
ORDER BY template_id, service, hour_of_day
```

At scoring time the scorer looks up the entry whose `hour_of_day` matches the current UTC hour. **Missing entries route directly to the new-template absolute-threshold path** — we deliberately do **not** fall back to a cross-hour mean. See "Why no cross-hour-mean fallback" below.

### Why 7 days

- Long enough to smooth one-day deploy noise and weekly maintenance windows.
- Short enough that a real regime change (new feature, new traffic shape) becomes the new baseline within a week — we don't want stale baselines either.
- Fits comfortably inside `template_stats`'s 30-day TTL with no schema change.

### Why hour-of-day, not day-of-week

Diurnal seasonality (24h cycle) is the dominant pattern in log volume — request rate at 3 AM is reliably 1/N of 3 PM regardless of weekday. Weekday seasonality is real but second-order; adding it would inflate the cache by 7× for a small accuracy gain. If the false-positive rate on weekends becomes a complaint, revisit.

### Why UTC, not tenant timezone

Operational simplicity. `interval_start` is stored as UTC; computing hour-of-day in the tenant's timezone would require a per-tenant timezone setting we don't have. The downside is that "hour 3" means "3 AM UTC" — for a tenant whose traffic peaks at noon local, the baseline buckets misalign by the timezone offset. Acceptable now; the front-end can present scored alerts in tenant-local time without changing the baseline math. Revisit if a customer's traffic seasonality is dominated by local-time effects.

### Why `HAVING uniq(interval_start) >= 3`

Without this guard, a single noisy 5-min bucket on day 0 of the window establishes the official baseline for that hour. On day 1 a modest burst against that 1-sample baseline trips the threshold, producing a false positive. Requiring 3 distinct buckets means the per-hour baseline is built from at least 3 days of observations at that hour-of-day before it becomes authoritative.

### Why no cross-hour-mean fallback

An initial design had `lookupBaseline()` fall back to the cross-hour mean for a `(tenant, service, template)` when the current hour had no entry. Adversarial review showed this re-introduces the exact diurnal-blindness this ADR exists to fix.

Counter-example: a peaky template (1000/hour daytime, 0/hour 2–5 AM) has a cross-hour mean ≈ 333. At 3 AM with no hour-3 row yet, a real anomaly of 50 events evaluates as `50 / 333 / 3 ≈ 0.05` and is silently swallowed. Without the fallback, the same 50-event burst routes to the new-template absolute-threshold path (`50 / 20 = 2.5`) and fires.

The new-template path is the well-tested safety net for "no baseline available". Falling back to a wrong-direction mean is strictly worse than falling back to a conservative absolute threshold. So the fallback is the existing new-template path; nothing in between.

### Why no `LIMIT` clause

An earlier draft kept the 1-hour query's `LIMIT 50000` row cap. With 24× cardinality from hour-of-day grouping, plausible tenants (~2k templates × 1 service × 24 hours ≈ 48k rows) sit at the cap; a second service truncates silently. The row payload is small (LowCardinality strings + a float), so a hard cap is the wrong tool. We rely on the `HAVING` guard and the natural cardinality bound of `(templates × services × 24)`. The scorer logs a warning if a single tenant's row count crosses `BASELINE_ROW_WARN_THRESHOLD` (100k) so high-cardinality tenants surface as an operational signal rather than as silently-truncated baselines.

## Alternatives Considered

### A. Just widen the window to 24h, keep the flat average

Cheapest fix. Eliminates the "spike becomes baseline in 1h" problem but does nothing for diurnal seasonality. Quiet-hour false positives would remain.

### B. Two-window scoring (1h short + 7d long, AND-gate alerts)

Reduces false positives during deploys and one-off traffic shifts (a deploy elevates the short window but not the long one). But it has the same blind spot the issue complains about: once the long window absorbs a sustained spike, alerts stop. Also doubles the failure surface (two queries, two thresholds, two cache shapes). Worth revisiting if false positives during deploys become a real complaint.

### C. Move scoring to the clusterer side

Drain3 has more state, but scoring at ingest time would couple template extraction to anomaly detection. Keeping them separate lets each evolve independently. Rejected.

### D. Cross-hour-mean fallback for unknown hours

Considered and rejected during adversarial review. See "Why no cross-hour-mean fallback" above.

## Consequences

### Positive

- Fixes all three problems the issue describes.
- Same query path, same MV, same TTL — no schema change.
- Hour-of-day key naturally segments traffic; sparse hours don't dilute peak-hour baselines.
- `HAVING` guard prevents 1-sample baselines from being treated as authoritative.

### Negative

- Baseline cache size grows from O(templates × services) to O(templates × services × 24). For a tenant with 1,000 templates × 5 services that's up to ~120K entries instead of ~5K. Still small (a few MB per tenant).
- Query cost: 7 days × 5-min buckets is 7× more rows scanned vs 1h. `template_stats` is materialised; scans are cheap. The scorer logs refresh duration per tenant so latency regressions surface.
- Cold-start tenants (less than 7 days of data) have partial baselines. The `HAVING >= 3` guard means an entry only lands when enough samples accrue; sparse hours route to the new-template absolute-threshold path until the data fills in. Existing warmup behaviour also keeps the score at 0 during the first 10 minutes per tenant+service. No regression.

## Verification

- `services/api/src/db/anomaly-queries.ts` exports `BASELINE_WINDOW_DAYS = 7` and `BASELINE_ROW_WARN_THRESHOLD = 100_000`, both asserted by tests.
- Tests cover same-hour matching, the "no fallback" behaviour for unknown hours, the new-template path, and that the SQL has the expected window/HAVING/ORDER BY shape.
- README's "rolling baseline" copy updated to "7-day baseline matched by hour-of-day (UTC)".

## Future Work

If false positives remain after this change, consider:

- Weekday seasonality (×7 multiplier on cache size).
- Tenant timezone for hour-of-day grouping (requires per-tenant TZ config).
- Deploy-marker-aware reset (after a deploy, ignore the prior baseline for N hours).
- Neighbour-hour smoothing to soften the discontinuity at hour boundaries for slowly-varying templates.

None of these are needed to ship the fix this ADR records.
