# Correlation Analysis & Support Intelligence Architecture

**Status:** PROPOSAL — awaiting adversarial review
**Author:** Claude (architecture session with Rob, 2026-03-21)
**Relates to:** Week 4+ roadmap, product differentiation

---

## 1. Problem Statement

LogWeave currently answers: "What errors are happening?" and "What changed?"

It cannot answer:
- "Is customer X having an abnormal experience?"
- "Is this a systemic issue or isolated to one customer?"
- "Does error A in service X cause error B in service Y?"
- "What's the root cause of this cascading failure?"

These are the questions support staff, SREs, and on-call engineers actually need answered.

## 2. Design Principles

- **Ocam's Razor** — simplest model that answers the question. No ML unless stats fail.
- **Affordable** — ClickHouse-native computation. No external analytics services.
- **Maintainable** — solo maintainer must understand every query. No magic.
- **Incremental** — each phase delivers standalone value. No big-bang.
- **No raw log storage** — this constraint remains absolute.

## 3. Existing Assets We Can Leverage

What we already have that's useful:

| Asset | How it helps |
|-------|-------------|
| `trace_id` in log_metadata | Links events across services in the same request |
| `template_stats` (5-min buckets) | Time-aligned pattern counts for correlation math |
| `service_stats` (1-hour buckets) | Service-level baselines for outlier detection |
| `anomaly_score` per event | Already detects per-template anomalies |
| Pre-processing strips PII | Tag extraction can safely extract business IDs |
| `neverExtract` mechanism | Existing pattern for controlling field extraction |

## 4. Architecture Proposal

### Phase 1: Context Tags

**Goal:** Enable queries like "show me errors where customer_id=ACME-123"

**Approach:** Extract key-value tags from structured log events during ingestion.
Store as a dedicated lightweight table, not as columns on log_metadata.

#### Tag Extraction

Extend the existing field extraction in the ingest pipeline:

```
New field in ingest batch config:
  extractTags: ['customer_id', 'order_id', 'user_id', 'request_id']
```

During ingestion, if these keys exist in the log event, extract them as tags.
Tags are stored separately — they're a cross-reference, not part of the event.

#### Storage: `logweave.event_tags`

```sql
CREATE TABLE logweave.event_tags (
    tenant_id       LowCardinality(String),
    event_id        String,              -- references log_metadata.id
    template_id     String,              -- denormalized for query efficiency
    service         LowCardinality(String),
    timestamp       DateTime64(3),
    tag_key         LowCardinality(String),
    tag_value       String,
    INDEX idx_tag_value tag_value TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, tag_key, tag_value, timestamp)
TTL toDateTime(timestamp) + toIntervalDay(30) DELETE
```

**Why a separate table?**
- log_metadata's ORDER BY is (tenant, service, timestamp, level) — tag queries need (tenant, tag_key, tag_value, timestamp)
- Avoids widening the hot fact table for a sparse dimension
- Tags are opt-in per tenant — no storage cost for tenants that don't use them
- Clean separation of concerns

#### Tag Aggregates: `logweave.tag_stats`

```sql
CREATE TABLE logweave.tag_stats (
    tenant_id       LowCardinality(String),
    tag_key         LowCardinality(String),
    tag_value       String,
    service         LowCardinality(String),
    template_id     String,
    interval_start  DateTime64(3),       -- 5-minute buckets (aligned with template_stats)
    occurrence_count AggregateFunction(count),
    error_count     AggregateFunction(countIf, UInt8)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(interval_start)
ORDER BY (tenant_id, tag_key, tag_value, service, interval_start)
TTL toDateTime(interval_start) + toIntervalDay(30) DELETE
```

Populated by a materialized view on event_tags JOIN log_metadata.

#### New MCP Tool: `customer_errors`

```
customer_errors(tag_key="customer_id", tag_value="ACME-123", hours=24)
```

Returns: error patterns affecting this customer, with counts.

### Phase 2: Cross-Service Correlation

**Goal:** Detect that error patterns in different services move together.

**Approach:** Pearson correlation coefficient on 5-minute count time series between template pairs.

#### How It Works

1. For every pair of high-occurrence templates (across different services), compute correlation over a rolling 24-hour window.
2. Correlation > 0.7 with > 10 data points = "correlated".
3. Store correlation pairs in a table for fast lookup.

#### Storage: `logweave.template_correlations`

```sql
CREATE TABLE logweave.template_correlations (
    tenant_id        LowCardinality(String),
    template_id_a    String,
    service_a        LowCardinality(String),
    template_id_b    String,
    service_b        LowCardinality(String),
    correlation      Float32,            -- Pearson coefficient (-1 to 1)
    sample_count     UInt32,             -- number of intervals compared
    computed_at      DateTime64(3),
    window_hours     UInt16              -- window size used
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (tenant_id, template_id_a, template_id_b)
```

#### Computation Strategy

**NOT real-time.** Correlations are computed:
- On-demand when `correlations` MCP tool is called (lazy)
- Cached in `template_correlations` table with a 1-hour TTL
- Scoped to templates with >= 20 occurrences (ignore noise)

The Pearson calculation is a single ClickHouse query:

```sql
SELECT
    a.template_id AS template_id_a,
    b.template_id AS template_id_b,
    corr(a_count, b_count) AS correlation,
    count() AS sample_count
FROM (
    SELECT interval_start, template_id, countMerge(occurrence_count) AS a_count
    FROM template_stats
    WHERE tenant_id = ? AND template_id IN (?)
    GROUP BY interval_start, template_id
) a
JOIN (
    SELECT interval_start, template_id, countMerge(occurrence_count) AS b_count
    FROM template_stats
    WHERE tenant_id = ? AND template_id IN (?)
    GROUP BY interval_start, template_id
) b ON a.interval_start = b.interval_start AND a.template_id != b.template_id
GROUP BY a.template_id, b.template_id
HAVING sample_count >= 10 AND abs(correlation) > 0.7
```

**ClickHouse has a native `corr()` aggregate function.** No external computation needed.

#### New MCP Tool: `correlations`

```
correlations(template_id="019cfb61-a232-...", hours=24)
```

Returns: correlated patterns in other services, with correlation coefficient and direction.

### Phase 3: Customer Outlier Detection

**Goal:** Answer "Is customer X's experience abnormal compared to everyone else?"

**Approach:** Compare customer's error rate against the population using z-score.

#### How It Works

1. Query `tag_stats` for the specific customer's error rate in the last N hours.
2. Query `tag_stats` for the population's error rate (all customers) in the same window.
3. Compute z-score: `(customer_rate - population_mean) / population_stddev`
4. z > 2.0 = outlier (95th percentile)

This is a single query:

```sql
WITH
  customer AS (
    SELECT countMerge(error_count) / countMerge(occurrence_count) AS error_rate
    FROM tag_stats
    WHERE tenant_id = ? AND tag_key = 'customer_id' AND tag_value = ?
      AND interval_start > now64(3) - toIntervalHour(?)
  ),
  population AS (
    SELECT
      avg(error_rate) AS mean_rate,
      stddevPop(error_rate) AS stddev_rate
    FROM (
      SELECT tag_value, countMerge(error_count) / countMerge(occurrence_count) AS error_rate
      FROM tag_stats
      WHERE tenant_id = ? AND tag_key = 'customer_id'
        AND interval_start > now64(3) - toIntervalHour(?)
      GROUP BY tag_value
      HAVING countMerge(occurrence_count) >= 10
    )
  )
SELECT
  customer.error_rate,
  population.mean_rate,
  population.stddev_rate,
  (customer.error_rate - population.mean_rate) / greatest(population.stddev_rate, 0.001) AS z_score
FROM customer, population
```

#### New MCP Tool: `customer_health`

```
customer_health(customer_id="ACME-123", hours=24)
```

Returns:
- Customer error rate vs population average
- Z-score (is this an outlier?)
- Which error patterns are elevated for this customer
- Whether the issue correlates with systemic patterns (cross-ref Phase 2)

### Phase 4: Incident Narrative

**Goal:** Auto-generate a timeline of what happened during an incident.

**Approach:** Given a time window, construct a narrative from:
- Deploy markers in the window
- New/spiking patterns (existing `changes` data)
- Cross-service correlations (Phase 2)
- Customer impact scope (Phase 3)

This is a **pure composition layer** — no new storage, just a new MCP tool
that calls existing tools and correlations, then formats a timeline.

#### New MCP Tool: `incident_narrative`

```
incident_narrative(since="2026-03-20T09:00:00Z", service="payments-api")
```

Returns: A structured timeline like:
```
09:00 — payments-api v1.8.0 deployed (commit e4f5g6h)
09:05 — NEW: "Gateway timeout: <*> did not respond within <*>" appeared (payments-api)
09:08 — CORRELATED: "Circuit breaker OPEN for <*>" spiking in api-gateway (r=0.92)
09:10 — 3 customers reporting elevated error rates (ACME-123: z=3.2, BETA-456: z=2.8)
09:15 — "Upstream timeout" resolved in api-gateway
09:18 — Payment timeouts stabilizing
```

## 5. Pipeline Changes

### Ingest Changes (Phase 1 only)

```
Current pipeline:
  Parse → Cluster → Enrich → INSERT log_metadata

New pipeline:
  Parse → Cluster → Enrich → INSERT log_metadata
                            → Extract Tags → INSERT event_tags (if extractTags configured)
```

Tag extraction is:
- **Opt-in** — only runs if `extractTags` is configured in the batch request
- **Non-blocking** — tag insert failures don't fail the ingest
- **Lightweight** — just plucking known keys from already-parsed JSON

### No Changes Required for Phases 2-4

Phases 2-4 are **read-path only**. They query existing data (template_stats, tag_stats)
and compute correlations on demand. Zero ingest pipeline changes.

## 6. MCP Tool Summary (Final State)

| Tool | Phase | Question it answers |
|------|-------|-------------------|
| `overview` | Existing | "How's the system?" |
| `error_patterns` | Existing | "What errors are happening?" |
| `service_health` | Existing | "How's this service doing?" |
| `search_templates` | Existing | "Any timeout issues?" |
| `template_detail` | Existing | "Tell me about this pattern" |
| `changes` | Existing | "What changed since the deploy?" |
| `deploys` | Existing | "When was the last deploy?" |
| `customer_errors` | Phase 1 | "What errors is customer X seeing?" |
| `correlations` | Phase 2 | "What other patterns move with this one?" |
| `customer_health` | Phase 3 | "Is customer X's experience abnormal?" |
| `incident_narrative` | Phase 4 | "What happened during this incident?" |

## 7. Cost Analysis

### Storage

| Table | Estimated Size per 1M events/day | Notes |
|-------|----------------------------------|-------|
| event_tags | ~50 MB/day | Sparse — only events with configured tag keys |
| tag_stats (MV) | ~5 MB/day | Aggregated 5-min buckets, much smaller |
| template_correlations | ~1 MB | Cached, not growing linearly |

### Compute

| Operation | Cost | When |
|-----------|------|------|
| Tag extraction | ~0 (in-memory key lookup) | During ingest |
| Tag insert | 1 additional INSERT per batch | During ingest |
| Correlation query | 1 heavy ClickHouse query (~100ms) | On-demand, cached 1hr |
| Outlier z-score | 1 medium ClickHouse query (~50ms) | On-demand |
| Incident narrative | 3-5 API calls composed | On-demand |

### Compared to Alternatives

- **Separate analytics DB:** $100+/mo for even a small instance. We use ClickHouse we already have.
- **External correlation service:** Adds a dependency, latency, and cost. ClickHouse `corr()` is free.
- **ML-based anomaly detection:** Complex, needs training data, hard to explain. Z-scores are transparent.

## 8. What This Does NOT Do

- **No raw log search** — we never store raw logs. Tag-based filtering searches metadata.
- **No distributed tracing UI** — trace_id is stored but we don't build Jaeger/Zipkin.
- **No ML/AI** — all analysis is statistical (correlation, z-score). Transparent and debuggable.
- **No real-time streaming** — correlations are computed on-demand from materialized views.

## 9. Open Questions

1. Should `extractTags` be configured per-tenant (in tenant_settings) or per-batch?
2. What's the max number of tag keys per tenant? (Suggested: 10)
3. Should correlations be pre-computed on a schedule, or purely on-demand?
4. For Phase 4 incident narrative — should the MCP tool return structured data or pre-formatted text?
5. Is the MV-based approach for tag_stats sufficient, or do we need a separate aggregation job?
