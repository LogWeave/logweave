# ADR-006: Week 1a Clusterer Architecture Decisions

**Status:** Accepted
**Date:** 2026-03-13
**Deciders:** Solo maintainer

## Context

Week 1a builds the clusterer service as a standalone FastAPI application wrapping Drain3.
Several architecture decisions were needed before implementation, informed by the Drain3
validation results (ADR-005) and multi-instance scalability requirements. These were
decided during planning based on parallel research and two rounds of adversarial review.

PLAN.md specifies UInt64 auto-increment template IDs and cityHash64-based lookups. This
ADR documents where the implementation diverges from PLAN.md and why.

## Decisions

### 1. Template IDs are UUIDv7 (not auto-increment UInt64)

PLAN.md specifies `template_id UInt64` with a process-level lock to coordinate
auto-increment assignment. This works for a single clusterer instance but creates a
coordination problem at two or more instances — each would need a shared counter or
range allocation.

**Decision:** Use UUIDv7 (RFC 9562) for template IDs. UUIDv7 is timestamp-sortable
(first 48 bits are millisecond Unix timestamp) and globally unique without coordination.
Generated via `uuid_utils.uuid7()` in Python. Stored as `String` in ClickHouse (the
native `UUID` type is UUIDv4-only).

**Rejected:** Auto-increment UInt64 with process-level lock (PLAN.md default) — breaks
at 2+ instances. cityHash64 of template text as ID — collisions are possible and hash
is not sortable by time.

### 2. Template registry stays in ClickHouse (not SQLite)

SQLite was considered as a simpler alternative for the template registry. It would
eliminate the `SELECT ... FINAL` complexity of ReplacingMergeTree.

**Decision:** Keep the registry in ClickHouse. SQLite uses file-level locking that breaks
when two clusterer instances share a volume. ClickHouse with UUIDv7 eliminates the
auto-increment race that was the original concern. ReplacingMergeTree with
`SELECT ... FINAL` provides consistent reads.

**Rejected:** SQLite — works for single instance but is a dead end for horizontal scaling.

### 3. In-memory cache for template lookups

Every incoming message needs a template ID lookup: hash the template text, check if it
exists, return the ID or create a new one. Hitting ClickHouse for every lookup adds
latency and load.

**Decision:** Maintain a `dict[(tenant_id, template_text_hash), template_id]` in the
clusterer process. Only cache misses (genuinely new templates) query ClickHouse. No
cache invalidation needed — template IDs are immutable once assigned.

**Trade-off:** The clusterer is stateful (cache lives in-process memory). Acceptable for
single-instance MVP. On restart, the cache rebuilds from ClickHouse on first access per
tenant. At scale, sticky routing by tenant_id ensures cache locality.

### 4. Pre-processing lives in the API server (Week 1b, not 1a)

PLAN.md's extraction pipeline (Section 9) runs pre-processing before calling the
clusterer. The question was whether to duplicate this logic in the clusterer.

**Decision:** Pre-processing stays in the API server. The clusterer receives
already-cleaned text. This is required for the unclustered recovery path: when
`template_id=0`, the API stores `pre_processed_message` and re-clusters on startup.
If pre-processing were only in the clusterer, the API couldn't recover without
re-extracting from raw logs (which we don't store).

**Consequence for Week 1a:** The clusterer's `POST /cluster` endpoint accepts
pre-processed text directly. No regex stripping in the clusterer. Drain3's built-in
MaskingInstruction is left unconfigured.

### 5. Custom checkpoint persistence with atomic rename

Drain3 provides `FilePersistence` for saving state to disk. It writes directly to the
target file — a crash mid-write corrupts the checkpoint irrecoverably.

**Decision:** Custom persistence wrapper. Write to `{path}.tmp`, then `os.replace()`
(atomic on POSIX, near-atomic on Windows/NTFS). This ensures the checkpoint file is
always either the old valid state or the new valid state, never a partial write.

**Checkpoint interval:** 60 seconds (from PLAN.md). Drain3 state is tiny (~12 KB for
113 templates per ADR-005), so frequent saves have negligible cost.

### 6. Per-tenant TemplateMiner instances

Each tenant gets its own Drain3 TemplateMiner. The alternative — a single shared miner
with tenant-prefixed messages — risks template cross-contamination where one tenant's
log patterns influence another's clustering.

**Decision:** `dict[tenant_id, TemplateMiner]` in the clusterer. Each tenant's Drain3
tree is independent. Checkpointed separately (one file per tenant).

**Scaling path:** When horizontal scaling is needed, shard clusterer instances by
`tenant_id` hash. Sticky routing ensures one instance owns each tenant's state.

## Consequences

- `uuid-utils` added as a production dependency
- ClickHouse `template_registry` schema changes: `template_id` becomes `String` (UUIDv7),
  `template_text_hash` stays `UInt64` (cityHash64, used for dedup lookups)
- Clusterer is stateful (in-memory cache + Drain3 state + checkpoints) — this is
  acceptable for MVP and has a documented scaling path
- Pre-processing split between API and clusterer simplifies the clusterer contract but
  means two services must agree on what "pre-processed" means — the API defines the
  contract, the clusterer just clusters whatever it receives
