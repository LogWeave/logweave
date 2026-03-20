# ADR-012: Correlation Analysis — Read-Path Only, No New Storage

**Status:** Accepted
**Date:** 2026-03-21
**Context:** MCP tool testing revealed LogWeave can answer "what errors exist?" but not "are these related?" or "is this service abnormal?" Two adversarial architecture reviews challenged a 4-phase proposal.

## Decision

Ship cross-service correlation and outlier detection as **read-path-only queries** against existing tables. Zero new tables. Zero pipeline changes. Four new MCP tools.

### What We're Building (Phase 0+1)

| Tool | Query Source | What It Answers |
|------|-------------|----------------|
| `trace_details` | `log_metadata` (trace_id) | "What happened across services in this request?" |
| `related_patterns` | `log_metadata` (trace_id co-occurrence) | "What patterns co-occur with this error in the same requests?" |
| `correlations` | `template_stats` (Pearson corr()) | "What patterns in other services move statistically with this one?" |
| `service_outlier` | `service_stats` (z-score) | "Is this service having an abnormal day vs its own baseline?" |

### What We're Deferring (Phase 2+3)

Customer-level filtering (tags, blast_radius, customer_health) requires:
- New `event_tags` table with denormalized `level` column
- Pipeline change (tag extraction during ingest, second INSERT)
- `tag_stats` MV (must be single-table, not a join — see rejected approaches)
- Cardinality guardrails (max 10 tag keys, document value cardinality limits)

**Trigger to build Phase 2:** A real customer asks "can I filter by customer ID?" Until then, the infrastructure cost is not justified.

## Rationale

### Why read-path only?

Write-path changes are the highest-risk changes in the system. The ingest pipeline is the critical path — every production log flows through it. Read-path additions (new query endpoints, new MCP tools) have zero impact on ingest reliability and are trivially reversible.

### Why trace_id first?

`log_metadata` already stores `trace_id` (extracted during parsing) but zero queries use it today. Trace-based correlation gives **causal** cross-service linking (same request), not just statistical correlation (patterns that move together). Higher precision, zero new infrastructure.

### Why anchor correlations to ONE template?

The original proposal computed all-pairs Pearson correlation. Both reviewers independently identified this as O(n^2) — a self-join that produces T*(T-1)/2 pairs. With 200 templates over 288 five-minute buckets, the join produces billions of intermediate rows, exceeding ClickHouse's `max_rows_to_read` guardrail.

Fix: The `correlations` tool takes a single `template_id` and finds its top correlated partners. This is O(T), not O(T^2).

### Why no correlation cache table?

The Pearson query on `template_stats` runs in ~100ms. Caching a 100ms query in a ReplacingMergeTree table adds: schema migration, FINAL semantics, TTL management, stale-data risk during incidents. Not worth it for a solo maintainer.

### Why drop the incident narrative tool?

LogWeave's product thesis: "intelligence layer that external LLMs query." The LLM IS the narrative layer. If we provide good structured data tools, the LLM composes the narrative with full conversational context. A hardcoded narrative tool is less flexible than what the LLM produces from the raw tools.

## Rejected Approaches

### tag_stats as a materialized view joining event_tags and log_metadata
ClickHouse MVs trigger on INSERT to a single source table. A cross-table MV join is not supported. If tags are built later, either denormalize `level` into `event_tags` (so the MV needs only one source) or compute aggregates on-demand.

### Map(String, String) column on log_metadata for tags
Simpler (one less table) but Map columns can't be in ORDER BY, making tag-value lookups full scans. Separate `event_tags` table with `ORDER BY (tenant_id, tag_key, tag_value, timestamp)` is correct for the access pattern. Deferred — not needed yet.

### ML-based anomaly correlation
Requires training data, is a black box, and is hard for a solo maintainer to debug. Pearson correlation and z-scores are transparent, explainable, and use ClickHouse native functions (`corr()`, `stddevPop()`).

### Pre-computed correlation on a schedule
Adds a background job (cron or interval), a results table, staleness management. The on-demand approach is simpler and gives fresh data during incidents when it matters most.

## Consequences

- Four new API endpoints, four new MCP tool registrations
- Zero schema migrations, zero pipeline changes
- Fully reversible — delete endpoints + tools if they prove useless
- Phase 2 (tags) architecture is documented here for when it's needed
- The `blast_radius` concept (Visionary review finding #18) becomes the flagship tool IF/WHEN tags are built

## Review History

- **Pragmatist reviewer:** "Ship just trace_details + correlations. Zero new tables. Two days of work."
- **Product visionary reviewer:** "Build toward blast_radius as the irreplaceable moment. But reorder phases — zero-infra first."
- **Synthesis:** Both agreed on read-path-only, both caught the MV bug and O(n^2) query, both identified trace_id as unused gold. Phase 0+1 is the consensus.
