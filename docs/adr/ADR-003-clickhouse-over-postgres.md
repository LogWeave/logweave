# ADR-003: ClickHouse Over PostgreSQL

**Status:** Accepted
**Date:** 2026-03-13

## Context

LogWeave stores time-series metadata: template occurrences, field statistics, anomaly
scores. Query patterns are predominantly analytical: "top errors in the last hour",
"template frequency over time", "new templates since deployment". Write volume is high
(batch inserts from log ingestion), read volume is low (dashboard queries, alerts).

## Decision

Use ClickHouse (single-node, Docker) as the sole metadata store. Use ReplacingMergeTree
for the template registry (deduplication) and MergeTree for log_metadata. Materialized
views for pre-aggregated stats (template_stats, service_stats).

## Consequences

- **Positive:** ClickHouse excels at columnar analytical queries on time-series data.
  Single-node deployment is operationally simple. Materialized views reduce query cost.
  Built-in TTL for automatic data expiry per retention tier.
- **Negative:** ReplacingMergeTree deduplication is asynchronous — all registry reads
  must use `SELECT ... FINAL` (see PLAN.md). No ACID transactions. Not suitable for
  user auth/session data (defer to a separate store if needed in Phase 2+).
- **Mitigated by:** Using `SELECT ... FINAL` consistently. Auth/billing data handled
  externally (Stripe, manual invoicing in MVP).
