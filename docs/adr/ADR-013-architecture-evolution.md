# ADR-013: Architecture Evolution — Research Findings and Decisions

**Status:** Accepted
**Date:** 2026-03-21

## Context

After completing Week 3 (LLM-Ready Pivot) and beginning Week 4 work (correlation analysis,
S3 connector, live tail), we paused to research whether our architecture is using the right
tools and patterns for our use cases. Three parallel research tracks investigated: log
clustering alternatives, real-time streaming patterns, and data storage/query architecture.

## Research Summary

### Log Clustering

**Finding:** Every major competitor (Datadog, Grafana Loki, Elastic, OpenObserve) uses Drain
or a Drain variant. No production-quality Node.js implementation exists. LLM-based parsing
is 10-100x slower with marginal accuracy gains. Vector embeddings don't produce template
texts (only similarity scores).

**Decision:** Keep Drain3. Add semantic template grouping as an async enrichment layer.

### Real-Time Streaming

**Finding:** SSE is the right choice for server-push. NATS JetStream is the lightest-weight
option for cross-instance broadcasting (~11MB image, native TTL, TypeScript client). Event
sourcing and CQRS are overkill for our scale. gRPC adds complexity for zero gain (Drain3
processing is the bottleneck, not serialization).

**Decision:** Keep SSE. Add NATS JetStream when scaling to 2+ API instances. Define the
EventBus abstraction now for clean migration.

### Data Storage

**Finding:** ClickHouse is correct for log metadata and analytical queries. No alternative
provides a net improvement. Config tables (watches, settings, connectors) are awkwardly
stored in ClickHouse with tombstone patterns — SQLite is the right tool for embedded config.
Vector search via ClickHouse-native `cosineDistance()` is sufficient for <100K templates.

**Decision:** Keep ClickHouse for analytics. Move config tables to SQLite. Use ClickHouse
`Array(Float32)` for template embeddings.

## Decisions

### 1. Semantic Template Search via fastembed + ClickHouse cosineDistance

**What:** Embed template texts with all-MiniLM-L6-v2 (384-dim, ~25MB model) at registration
time in the clusterer. Store vectors in ClickHouse `Array(Float32)`. Search with native
`cosineDistance()` function.

**Why:** Enables "database slow" → finds "connection pool exhausted". Makes MCP
`search_templates` tool dramatically more useful for LLM-driven investigation.

**Implementation:**
- Add `fastembed` to clusterer dependencies (ONNX-only, no PyTorch, ~50MB install)
- New `POST /embed` endpoint on clusterer (~5-10ms per embedding on CPU)
- Add `embedding Array(Float32)` + `embedding_model String` columns to `template_registry`
- API server embeds query text via clusterer, then runs cosineDistance query
- `?mode=semantic` param on search endpoint (default stays `substring`)
- Backfill existing templates on clusterer startup

**Performance:** <1ms for cosineDistance on 1000 vectors. No vector DB needed.
**No new containers.** No GPU. No external API calls.

### 2. NATS JetStream for Cross-Instance Event Broadcasting

**What:** When `LOGWEAVE_NATS_URL` is set, the ingest pipeline publishes tail events to
a NATS JetStream stream. Each API instance consumes all events via ordered push consumer
and populates its local TailBuffer. When NATS URL is not set, falls back to direct local
push (current behavior).

**Why:** Solves the multi-instance live tail gap. SSE clients on any instance see all events.
MCP cursor semantics work cross-instance.

**Implementation:**
- `EventBus` interface: `publishTailEvent()`, `subscribeTailEvents()`, `isConnected()`
- `LocalEventBus`: wraps direct TailBuffer.push (single-instance, current behavior)
- `NatsEventBus`: publishes to `logweave.tail.<tenant_id>`, ordered consumer populates TailBuffer
- Auto-detection: NATS URL present → NatsEventBus, absent → LocalEventBus
- Graceful degradation: if NATS goes down, falls back to local-only mode
- Stream config: memory storage, 90s MaxAge, 10K msgs per subject, discard oldest

**Docker:** `nats:2-alpine` (~11MB image, 30-50MB RAM idle)
**Dependencies:** `@nats-io/transport-node`, `@nats-io/jetstream`

**Future multi-purpose value:**
- Request-reply for clusterer RPC (when scaling to multiple clusterer instances)
- Alert broadcasting for external consumers
- JetStream KV buckets for distributed config (future Redis replacement)

### 3. SQLite for Config Tables

**What:** Move watches, tenant_settings, and tenant_connectors from ClickHouse
ReplacingMergeTree to SQLite (embedded, same API process).

**Why:** These tables store <1000 rows of CRUD config data. ClickHouse is an OLAP engine
designed for analytical queries on millions of rows. Using it for CRUD requires tombstone
patterns (is_deleted + version), SELECT FINAL for consistency, and write-through caches
to hide the latency. SQLite gives real ACID transactions, instant consistent reads,
UPDATE/DELETE, and zero network overhead.

**What stays in ClickHouse:** `template_registry` (cross-service shared state written by
the Python clusterer and read by the Node.js API — must be in a shared store).

**Implementation:**
- Add `better-sqlite3` dependency to API server
- Create `logweave.db` file with schema for watches, settings, connectors
- Migrate WatchStore, TenantSettingsStore, and connector queries to use SQLite
- Remove tombstone patterns (is_deleted, version columns) from these tables
- Remove write-through cache layer (SQLite reads are instant, no cache needed)
- ClickHouse DDL for these tables stays (for existing deployments) but new installs use SQLite

**Dependency:** `better-sqlite3` (~4M weekly npm downloads, synchronous API, no native compilation issues in Docker)

### 4. Daily Rollup MV for 365-Day Trend Analysis

**What:** New `template_daily_summary` ClickHouse table populated by a materialized view.
One row per template per service per day. 365-day TTL.

**Why:** Current 30-day TTL on template_stats means we lose trend data after one month.
The product vision ("this pattern first appeared 47 days ago and has been growing 4%/week")
requires longer retention. Daily rollups at ~100 bytes/row = ~300MB/tenant/year.

### 5. EventBus Abstraction (Immediate)

**What:** Extract the pub/sub pattern from TailBuffer.push() into a generic EventBus
interface. Two implementations: LocalEventBus (current) and NatsEventBus (future).

**Why:** Makes the NATS migration a swap of implementation, not a refactor. Zero
infrastructure cost — just a code abstraction.

## What We Explicitly Decided NOT to Do

| Idea | Why not |
|------|---------|
| Replace Drain3 with LLMs | 10-100x slower, costs money, non-deterministic |
| Port Drain3 to TypeScript | 2-4 weeks, premature optimization, Drain3 is battle-tested |
| Event sourcing | Adds complexity for 2 consumers. Recovery mechanism already provides durability. |
| CQRS | Rate limiting + query guard handle mixed workloads. Solo maintainer burden too high. |
| gRPC for API→clusterer | Bottleneck is Drain3 processing, not serialization |
| Replace ClickHouse | No alternative provides a net improvement for our analytical workload |
| Add PostgreSQL | 4th container for <1000 config rows. SQLite is simpler. |
| Add vector DB (Qdrant/Milvus) | ClickHouse cosineDistance is <1ms at our scale. Premature. |
| WebSocket instead of SSE | Industry trend supports SSE for server-push. Built-in reconnection. |
| Replace SSE with GraphQL subscriptions | Adds GraphQL layer for no functional gain. |

## Implementation Priority

| # | Change | Effort | Milestone |
|---|--------|--------|-----------|
| 1 | EventBus abstraction | 0.5 days | Now |
| 2 | Semantic template search (fastembed) | 1-2 days | Week 5 |
| 3 | SQLite for config tables | 2-3 days | Week 5 |
| 4 | Daily rollup MV | 1 day | Week 5 |
| 5 | NATS JetStream | 2-3 days | When scaling trigger hits |
| 6 | S3-backed audit storage | 0.5 days | Week 5 |

## Consequences

- Clusterer gains a new dependency (fastembed, ~50MB) and endpoint (/embed)
- API server gains a new dependency (better-sqlite3) and a local DB file
- Docker Compose gains NATS container when multi-instance is needed
- Template search becomes dramatically more useful for LLM consumers
- Config CRUD becomes simpler (no tombstones, no FINAL, no caching layer)
- 365-day trend analysis unlocks the "longitudinal record" product differentiator
- Architecture is prepared for multi-instance scaling without requiring it now

## Sources

Research conducted via three parallel agents with web search. Key references:
- Drain3 (logpai/Drain3), Grafana Loki Drain port (Go), Elastic categorize_text (modified Drain)
- NATS JetStream docs, @nats-io/jetstream npm, nats.js GitHub
- ClickHouse vector search (cosineDistance, Array(Float32)), vector_similarity index
- fastembed (qdrant/fastembed), all-MiniLM-L6-v2 (sentence-transformers)
- better-sqlite3 npm, SQLite documentation
- Competitor analysis: Datadog, Grafana Loki, Elasticsearch, Honeycomb, Sentry, PostHog
