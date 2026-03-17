# ADR-009: Scaling Readiness Assessment

**Status:** Accepted
**Date:** 2026-03-17
**Deciders:** Solo maintainer
**Context:** Issue #31 — Week 2 scaling readiness assessment. Two independent analysis agents
arrived at the same conclusions; this ADR is the synthesis.

## Context

The Week 1b benchmark harness (#26) measured the system at up to 42,240 events/sec peak
throughput (mock clusterer, 10 connections, 1000-event batches). With a real clusterer
adding 100-200ms per batch, realistic throughput is ~2,000-5,000 events/sec. For MVP
(2-5 customers at 1-10M events/day each), this gives 40-400x headroom.

This ADR documents where the architecture breaks, what the scaling path looks like,
and what preparatory work is needed. It answers five specific questions.

## Q1: At what load does the current architecture fail?

**The clusterer is the binding constraint.** The Python clusterer runs Drain3's
`add_log_message()` sequentially under a per-tenant lock, with a `Semaphore(4)` limiting
concurrent requests. The API server blocks on the clusterer's 500ms HTTP timeout per batch.

Everything else (Express HTTP handling, ClickHouse INSERTs, auth, enrichment) scales
better than the clusterer.

### Threshold Table

| Metric | Green | Yellow (investigate) | Red (action required) |
|--------|-------|---------------------|----------------------|
| Sustained events/sec | < 2,000 | 2,000-5,000 | > 5,000 |
| p99 ingest latency | < 300ms | 300-500ms | > 500ms |
| Circuit breaker | Never opens | Transient (recovers) | Sustained open |
| ClickHouse INSERTs/sec | < 10 | 10-20 | > 20 (excessive parts) |
| ClickHouse active parts | < 300 | 300-1,000 | > 1,000 |

**The primary metric to watch is p99 ingest latency on `/v1/ingest/batch`.**

### ClickHouse INSERT Rate Concern

ClickHouse recommends no more than ~1 INSERT per second per table for MergeTree engines
to avoid excessive part creation. At 10 concurrent ingest requests/sec, that is 10
INSERTs/sec — within limits but approaching the concern zone. This becomes the motivation
for INSERT coalescing at Stage 2.

## Q2: What is the scaling path?

Five stages, each triggered by specific metrics:

### Stage 0 — Current (Single Instance, Synchronous Pipeline)
- **Capacity:** ~2,000-5,000 events/sec
- **Architecture:** Docker Compose, 3 containers (API + clusterer + ClickHouse)
- **Sufficient for:** 2-5 customers, 1-10M events/day each

### Stage 1 — Multiple API Instances + Load Balancer
- **Trigger:** p99 ingest latency consistently > 300ms
- **Change:** Run 2-3 API instances behind nginx/ALB. Add `LOGWEAVE_RECOVERY_ENABLED`
  config flag so only one instance runs the recovery sweep (see Tracking Issues below).
- **Effort:** 1 day
- **Capacity:** ~2-3x API throughput, still clusterer-limited

### Stage 2 — BullMQ In-Process Queue (Redis, Same Compose)
- **Trigger:** p99 ingest latency consistently > 500ms despite multiple API instances
- **Change:** Ingest endpoint accepts batch, writes to Redis queue, returns 202.
  Background workers consume from queue, call clusterer, INSERT to ClickHouse.
  Workers coalesce INSERTs (reducing ClickHouse part pressure).
- **Effort:** 1 week
- **Capacity:** ~10,000-20,000 events/sec with INSERT coalescing
- **Prerequisites:** INSERT idempotency (dedup tokens), async result tracking

### Stage 3 — SQS + Fargate Workers (Exit Compose for Workers)
- **Trigger:** BullMQ queue depth growing unboundedly, or > 50 tenants
- **Change:** Replace BullMQ with SQS. Fargate workers auto-scale on queue depth.
- **Effort:** 1-2 weeks
- **Capacity:** Effectively unlimited ingestion (workers scale with demand)

### Stage 4 — Clusterer Sharding by Tenant ID Hash
- **Trigger:** Single clusterer CPU > 80%, or > 200 tenants
- **Change:** Hash `tenant_id` to one of N clusterer instances. API routes based on hash.
  Each clusterer holds a subset of tenant state.
- **Effort:** 1-2 weeks

### What NOT to do prematurely

- **No queue before p99 > 500ms.** Synchronous pipelines are simpler to debug, monitor,
  and reason about. Queues add failure modes (dead letters, ordering, exactly-once).
- **No clusterer sharding before 200 tenants or 80% CPU.** Sharding adds routing complexity
  and checkpoint coordination.
- **No ClickHouse sharding before 500GB/day.** Single-node handles expected load for 12+ months.

## Q3: Is the pipeline queue-compatible?

**Mostly yes.** `ingestBatch()` in `services/api/src/pipeline/ingest.ts` is cleanly
separable — it takes `{clusterClient, db, logger}` and operates on data. A queue worker
instantiates the same dependencies and calls it directly. The HTTP-specific glue in
`routes/ingest.ts` is thin (auth + validation + calling ingestBatch).

### Three changes needed for queue stage

1. **INSERT idempotency.** Current batch INSERT is not idempotent — retrying creates
   duplicate rows. Fix: use ClickHouse's `insert_deduplication` setting with a
   deterministic dedup token (hash of batch content). Simpler than migrating
   `log_metadata` to ReplacingMergeTree.

2. **Async result tracking.** Current: client waits for `IngestResult`. Queue model:
   return 202 Accepted immediately, track result via metrics or status table.

3. **Tenant ID in message body.** Current: extracted from HTTP Bearer token. Queue:
   include `tenant_id` in the message payload (SQS metadata or body field).

## Q4: Can we run multiple API instances today?

**Yes, with one fix.** Three things are affected:

### Recovery Sweep — BREAKS (must fix)

Each API instance runs its own `RecoverySweep` independently. Multiple instances will
fetch the same `template_id='0'` rows and attempt recovery simultaneously. INSERT-first
ordering prevents data loss, but creates duplicate rows (different UUIDv7 IDs for the
same recovered event).

**Fix:** Add `LOGWEAVE_RECOVERY_ENABLED` env var (default `true`). Set to `false` on all
but one instance. Simple, no distributed lock needed. Tracked in issue (see below).

### Per-Instance Metrics — COSMETIC

The metrics module uses a global `Map<string, number>`. Each instance has its own counters.
Not a correctness problem; monitoring needs aggregation. Deferred to Prometheus integration.

### Circuit Breaker State — ACCEPTABLE

Each instance maintains independent circuit breaker state. This is correct behavior —
each instance has its own view of clusterer health. At 5+ instances, consider shared
health check (Redis), but not needed for 2-3.

### What does NOT break

- **Auth:** Stateless SHA-256, env-var config. No session affinity needed.
- **Express middleware:** Request ID uses AsyncLocalStorage (per-request, per-process).
- **ClickHouse writes:** Concurrent-safe natively.
- **Clusterer:** Handles concurrent requests via semaphore + per-tenant locks.
- **Graceful shutdown:** Coordinated drain with 10s timeout.

### Readiness Matrix

| Component | Scale-Ready? | What Breaks | Fix Effort |
|-----------|-------------|-------------|------------|
| Auth / Express / Pipeline | Yes | Nothing | 0 |
| Circuit breaker | Yes | Per-instance state (correct) | 0 |
| ClickHouse writes | Yes | Concurrent-safe natively | 0 |
| Graceful shutdown | Yes | Coordinated drain works | 0 |
| Recovery sweep | **No** | Duplicate recovery | 1 day (config flag) |
| Metrics | No | Per-instance counters | Deferred to Prometheus |
| Transport SDK (429) | No | Drops instead of retrying | 1 day |
| Batch INSERT | Partial | Not idempotent on retry | 2-3 days (Stage 2 only) |

## Q5: Should the API return 429 under load?

**Yes, with clear semantics:**

- **429 Too Many Requests** = "you're sending too much" (per-tenant rate limit).
  Include `Retry-After` header (seconds until window resets).
- **503 Service Unavailable** = "server is broken" (ClickHouse down, overloaded).
  Transport SDK already retries 5xx.

### Transport SDK 429 Gap

The transport SDK currently treats all 4xx responses identically: drop the batch
immediately, no retry. This is correct for 400/401/403/422 (retrying won't help),
but **wrong for 429** which explicitly means "try again later."

**Required change (tracked in issue below):** `retryFetch()` in
`packages/transport/src/retry.ts` must distinguish 429 from other 4xx:
- Read `Retry-After` header; sleep for that duration (capped at 30s)
- If absent, use exponential backoff (same as 5xx)
- Retry up to `maxRetries` times
- Only drop after all retries exhausted

### Rate Limiting Design (Week 4)

Per-tenant sliding window (events/sec). Default threshold configurable via env var.
When exceeded, return 429 with `Retry-After`. No rate limiting code now — this ADR
establishes the contract.

## Consequences

### Next 3 months (0-5 customers)
- No scaling changes needed. 40-400x headroom over expected load.
- Monitor p99 ingest latency as the primary scaling indicator.
- Prep work: recovery config flag, 429 transport handling (Week 4).

### Months 3-6 (5-20 customers)
- If p99 > 300ms: scale to 2-3 API instances (Stage 1).
- If p99 > 500ms: evaluate BullMQ queue (Stage 2).
- Consider INSERT deduplication if multi-instance recovery duplicates are measurable.

### Months 6-12 (20-50 customers)
- SQS + Fargate (Stage 3) if BullMQ queue depth grows unboundedly.
- Clusterer sharding (Stage 4) if single clusterer CPU > 80%.

## Tracking Issues

Action items from this ADR are tracked as GitHub Issues on the Week 4 milestone:

- **#38 — Recovery config flag:** `LOGWEAVE_RECOVERY_ENABLED` env var for multi-instance safety
- **#39 — Transport SDK 429 handling:** Retry with Retry-After, distinguish from other 4xx
- **#40 — Per-tenant rate limiting:** 429 responses with Retry-After header
