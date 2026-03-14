# ClickHouse Design Research — LogWeave

*Researched 2026-03-14 for issue #14. Reference for future agents — do not re-research these questions.*

---

## Skip Index Types for High-Cardinality String (UUID) Columns

**TL;DR:** Use `bloom_filter(0.01) GRANULARITY 1` for UUID string columns. Roaring Bitmaps and Cuckoo Filters do NOT exist as skip index types in ClickHouse 24.x.

### What ClickHouse Actually Supports

ClickHouse 24.x has exactly these skip index types:
- `set(N)` — exact values per granule (low cardinality only)
- `bloom_filter(p)` — probabilistic membership, full string hashed as one atom
- `ngrambf_v1(n, size, hashes, seed)` — n-gram bloom filter (for LIKE/substring search)
- `tokenbf_v1(size, hashes, seed)` — token bloom filter (for word search)
- `minmax` — min/max range per granule

**Roaring Bitmap skip index: does not exist.** ClickHouse uses Roaring Bitmaps internally for aggregate functions (`groupBitmapState`, `bitmapAnd`), but not as a skip index type.

**Cuckoo Filter skip index: does not exist.** No `MergeTreeIndexCuckooFilter` in ClickHouse source as of 24.x.

### Why bloom_filter is correct for UUID equality lookups

- `bloom_filter(p)` hashes the full UUID string as one atomic value — no tokenization.
- `ngrambf_v1`: extracts 33 overlapping 4-grams per 36-char UUID. UUIDs share many hex n-grams → filter saturates fast → high effective false positive rate.
- `tokenbf_v1`: splits UUID on hyphens into 5 tokens (4 chars each). 16^4 = 65,536 possible 4-char hex tokens. 8,192 rows × 5 tokens = 40,960 inserts into filter → saturation → useless.
- `set(N)` on UUID: would need N ≥ distinct UUIDs per granule (potentially thousands) → prohibitive storage.

### Correct DDL

```sql
-- For level (4 possible values: ERROR/WARN/INFO/DEBUG)
INDEX idx_level level TYPE set(5) GRANULARITY 1,

-- For template_id (UUID strings, high cardinality)
INDEX idx_template_id template_id TYPE bloom_filter(0.01) GRANULARITY 1
```

`GRANULARITY 1` = one index entry per primary key granule (8192 rows). Standard value.

---

## MV Engine: AggregatingMergeTree vs SummingMergeTree for AVG

**SummingMergeTree with avg() is a correctness bug.**

When you write `avg(duration_ms)` in a SummingMergeTree MV, ClickHouse computes a partial avg per insert batch, then *sums* those averages during background merges. Averaging the averages without weighting by count is mathematically wrong.

**AggregatingMergeTree with avgState/avgMerge** is correct. Stores (sum, count) pair per partial state; merges are always correct.

### Full MV pattern

```sql
-- Target table
CREATE TABLE IF NOT EXISTS template_stats (
    ...
    avg_duration_ms  AggregateFunction(avg, Float64),
    ...
) ENGINE = AggregatingMergeTree();

-- MV (writes partial states)
CREATE MATERIALIZED VIEW IF NOT EXISTS template_stats_mv
TO template_stats AS
SELECT ..., avgState(duration_ms) AS avg_duration_ms, ...
FROM log_metadata
WHERE template_id != '0'
GROUP BY ...;

-- Read query (merges states)
SELECT ..., avgMerge(avg_duration_ms) AS avg_duration_ms, ...
FROM template_stats
WHERE ...
GROUP BY ...;
```

Use `countState()`, `countIfState()`, `maxState()`, `avgState()` in MV SELECT.
Use `countMerge()`, `countIfMerge()`, `maxMerge()`, `avgMerge()` in read SELECT.
Always include all GROUP BY keys in the read SELECT.

---

## Nullable Columns

**Do not use Nullable unless semantically required.** Nullable columns add a separate null-mask file — every read must load and check it, adding I/O and CPU overhead.

**`Nullable(LowCardinality(String))` is invalid DDL.** ClickHouse rejects it with:
> `Nested type LowCardinality cannot be inside Nullable type`

Valid nesting is `LowCardinality(Nullable(String))` (the reverse), but this negates most LowCardinality benefits.

### Correct pattern for optional columns

| Column | Type | Default |
|---|---|---|
| `status_code` | `UInt16` | `DEFAULT 0` |
| `duration_ms` | `Float64` | `DEFAULT 0` |
| `trace_id` | `String` | `DEFAULT ''` |
| `route` | `LowCardinality(String)` | `DEFAULT ''` |
| `pre_processed_message` | `Nullable(String)` | keep — semantically meaningful null |

`pre_processed_message` is the one exception: it's `NULL` for clustered rows and populated for unclustered rows (template_id='0'). An empty string sentinel would make "never clustered" vs "clustered with empty message" indistinguishable.

---

## Partition Strategy for Multi-Tenant Tables

**Do not include tenant_id in PARTITION BY.**

`PARTITION BY (tenant_id, toYYYYMM(timestamp))` with N tenants × M months = N×M partitions. ClickHouse cannot merge parts across partition boundaries. At 50 tenants × 12 months = 600 partition keys → too many small parts → risk of "Too many parts" error (threshold: 300 active parts per partition).

**Correct:** `PARTITION BY toYYYYMM(timestamp)` — at most 12–24 active partitions regardless of tenant count. Tenant isolation for queries comes from the sort key: `ORDER BY (tenant_id, service, ...)` allows ClickHouse to skip entire granules where tenant_id doesn't match.

---

## TTL: ttl_only_drop_parts = 1

Table-level SETTINGS option. Controls TTL enforcement strategy:

- **Default (0):** Runs mutation to delete individual rows across parts when TTL expires. Expensive — rewrites parts, high I/O.
- **ttl_only_drop_parts = 1:** Only drops an entire part when *all* rows in it have expired. O(1) metadata operation.

For a table partitioned by `toYYYYMM(timestamp)` with a 30-day TTL: parts from the oldest month will entirely expire after 30 days → whole part dropped instantly. Monthly partitions align perfectly with 30-day TTL. **Always include this setting.**

```sql
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1;
```

---

## async_insert — Skip for Batch Ingest Path

`async_insert=1` buffers INSERT statements server-side, flushing when buffer hits 1MB or after 200ms timeout. Designed for scenarios where many independent clients send small individual inserts (can't batch on the application side).

When the application batches rows and sends one large INSERT (the LogWeave ingest path), async_insert is redundant and harmful: data sits in the server buffer waiting for the 200ms timeout even though the batch was already large. `wait_for_async_insert=1` (safe default) means the application also waits 200ms.

**Do not use async_insert for the batch ingest path.** Document in code.

---

## Resource Guardrails

Apply user-level settings via `ALTER USER` in schema init. Runs during startup — no config file mount required for Docker Compose.

```sql
ALTER USER default SETTINGS
    max_execution_time = 30,
    max_memory_usage = 1073741824,  -- 1 GB
    max_rows_to_read = 10000000;    -- 10M
```

For dashboard/query endpoints, also pass `max_execution_time` per-query as defense-in-depth. `max_rows_to_read` does not apply to INSERT operations.

---

## WHERE template_id Predicate

`template_id` is `String`. The unclustered sentinel is `'0'` (not numeric 0, not nil UUID).

- `WHERE template_id > 0` — type error (comparing String to integer)
- `WHERE template_id != '0'` — correct ✓

Use `'0'` as the sentinel (not `'00000000-0000-0000-0000-000000000000'`). UUIDs never look like `'0'`, so the sentinel is unambiguous.

---

## @clickhouse/client npm Package Notes

- `client.insert({ table, values, format: 'JSONEachRow' })` for batch inserts
- `client.query({ query, query_params })` for parameterized SELECT
- Parameterized query syntax: `WHERE tenant_id = {tenant_id:String}` in SQL, pass `{ query_params: { tenant_id: 'abc' } }` in options
- `clickhouse_settings` key on any call for per-query settings override
- Never use string interpolation to build queries — use parameterized form only

---

## Sources

- https://clickhouse.com/docs/optimize/avoid-nullable-columns
- https://clickhouse.com/docs/optimize/skipping-indexes
- https://clickhouse.com/blog/using-materialized-views-in-clickhouse
- https://clickhouse.com/docs/best-practices/choosing-a-partitioning-key
- https://clickhouse.com/docs/cloud/bestpractices/multi-tenancy
- https://clickhouse.com/blog/asynchronous-data-inserts-in-clickhouse
- https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree
