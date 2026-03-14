# ClickHouse Schema Divergences from PLAN.md

**Status:** Accepted
**Date:** 2026-03-14
**Deciders:** Solo maintainer
**Context:** Issue #14 — ClickHouse schema + client + query discipline for the API server.
Specialist research validated 8 deviations from PLAN.md's original schema. Full research
in `docs/clickhouse-research.md`.

## Context

PLAN.md v8 defined the ClickHouse schema for `log_metadata`, `template_stats`, and
`service_stats`. During implementation, a ClickHouse specialist agent researched each
design choice, followed by an adversarial reviewer. Several correctness bugs and
scalability issues were found in the original spec.

## Decisions

### 1. AggregatingMergeTree for materialized views (not SummingMergeTree)

PLAN.md used `SummingMergeTree` for both MVs, which contain `avg(duration_ms)` and
`avg(anomaly_score)`. SummingMergeTree sums numeric columns during background merges —
averaging pre-computed averages without weighting by count produces mathematically
incorrect results.

**Decision:** Use `AggregatingMergeTree` with `avgState()`/`avgMerge()`,
`countState()`/`countMerge()`, `countIfState()`/`countIfMerge()`, and
`maxState()`/`maxMerge()`. Stores partial aggregation state (sum + count pairs for avg),
producing correct results after any number of merges.

### 2. No Nullable columns except pre_processed_message

PLAN.md used `Nullable(UInt16)`, `Nullable(Float64)`, `Nullable(String)`, and
`Nullable(LowCardinality(String))` for optional columns.

Problems:
- `Nullable(LowCardinality(String))` is invalid DDL — ClickHouse rejects this nesting
- Nullable columns require a separate null-mask file per column, adding I/O overhead
- ClickHouse docs explicitly recommend against Nullable columns

**Decision:** Use non-Nullable types with sensible defaults: `UInt16 DEFAULT 0`,
`Float64 DEFAULT 0`, `String DEFAULT ''`, `LowCardinality(String) DEFAULT ''`.
Exception: `pre_processed_message Nullable(String)` — semantically meaningful null
(distinguishes "never clustered" from "clustered with empty message").

### 3. PARTITION BY toYYYYMM(timestamp) only (no tenant_id)

PLAN.md partitioned by `(tenant_id, toYYYYMM(timestamp))`. With N tenants × M months of
active data, this creates N×M partitions. ClickHouse cannot merge parts across partition
boundaries — too many small partitions triggers "Too many parts" errors at scale.

**Decision:** Partition by `toYYYYMM(timestamp)` only. At most 12–24 active partitions
regardless of tenant count. Tenant isolation comes from the ORDER BY prefix
`(tenant_id, ...)` which enables granule-level skipping.

### 4. bloom_filter(0.01) for template_id skip index (not set(100))

Issue #14 originally specified `set(100)` for template_id. Template IDs are UUID strings
— extremely high cardinality. Any group of 8192 rows will have far more than 100 distinct
UUIDs, causing set(100) to store nothing and become useless.

Evaluated alternatives:
- Roaring Bitmaps: not available as a skip index type in ClickHouse 24.x
- Cuckoo Filters: not available as a skip index type in ClickHouse 24.x
- ngrambf_v1: designed for substring search, saturates fast on UUID n-grams
- tokenbf_v1: splits UUIDs on hyphens into short tokens, extreme collision rate

**Decision:** `bloom_filter(0.01) GRANULARITY 1`. Hashes full UUID as one atom.
1% false positive rate per granule. Only viable option for equality on high-cardinality
string columns.

### 5. WHERE template_id != '0' (not > 0)

PLAN.md used `WHERE template_id > 0` in the template_stats MV. template_id is `String`,
not numeric — comparing String to integer literal 0 is a type error.

**Decision:** `WHERE template_id != '0'`. The unclustered sentinel is the string `'0'`,
which is unambiguous since real template IDs are UUIDs.

### 6. ttl_only_drop_parts = 1

PLAN.md omitted this setting. Without it, ClickHouse runs row-level mutations to delete
expired rows — expensive I/O. With it, ClickHouse drops entire parts when all rows have
expired — an O(1) metadata operation.

**Decision:** Include `ttl_only_drop_parts = 1`. Monthly partitions align perfectly with
the 30-day TTL — expired parts will always be entirely old.

### 7. ORDER BY (tenant_id, service, timestamp, level) — swapped timestamp and level

PLAN.md used `(tenant_id, service, level, timestamp)`. The dashboard's dominant query
pattern is time-range queries within a tenant+service, not level-filtered full-time scans.

**Decision:** Put timestamp before level in ORDER BY. Optimizes for time-range queries
(the common path). Level filtering is secondary and handled by the set(5) skip index.

### 8. No async_insert for batch ingest path

Issue #14 originally specified "with async_insert support". The API server accumulates
rows in memory and flushes one large INSERT per batch — exactly the pattern async_insert
is not designed for. Server-side buffering adds 200ms latency with zero throughput benefit.

**Decision:** Synchronous batch insert only. Documented in code for future reference.
If a future use case (e.g., Winston transport sending individual log lines) needs
async_insert, add it per-call at that time.

## Schema Immutability

This schema is immutable until Week 4 when a versioned migration runner is implemented.
Any schema changes before then require a manual migration or table recreation.

## References

- Full research: `docs/clickhouse-research.md`
- ClickHouse docs: avoid-nullable-columns, skipping-indexes, choosing-a-partitioning-key
- Issue #14 acceptance criteria and reviewer findings
