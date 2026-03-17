# Architecture Decision Records

Architectural decisions for the LogWeave platform, documented as they are made.

All decisions are **Accepted** unless noted otherwise.

| # | Decision | Date | Summary |
|---|----------|------|---------|
| 001 | [Two-Language Stack (Python + Node.js)](ADR-001-two-language-stack.md) | 2026-03-13 | Python/FastAPI for clusterer (Drain3), Node.js/Express for API server |
| 002 | [No Raw Log Storage](ADR-002-no-raw-log-storage.md) | 2026-03-13 | Store only metadata, patterns, and source pointers — never raw logs |
| 003 | [ClickHouse Over PostgreSQL](ADR-003-clickhouse-over-postgres.md) | 2026-03-13 | ClickHouse (single-node, Docker) as sole metadata store |
| 004 | [Docker Compose, Not Kubernetes](ADR-004-docker-compose-not-k8s.md) | 2026-03-13 | Docker Compose for deployment — no orchestration for MVP |
| 005 | [Drain3 Pre-Build Validation Results](ADR-005-drain3-validation-results.md) | 2026-03-13 | Validation passed all 4 gates — GO for production |
| 006 | [Week 1a Clusterer Architecture](ADR-006-week1a-clusterer-architecture.md) | 2026-03-13 | UUIDv7 template IDs, ClickHouse registry, in-memory cache, atomic checkpoints |
| 007 | [Week 1a Postmortem Hardening](ADR-007-postmortem-hardening-decisions.md) | 2026-03-14 | Schema defaults, deferred rate limits, GIL-based safety, optional HMAC |
| 008 | [ClickHouse Schema Divergences](008-clickhouse-schema-divergences.md) | 2026-03-14 | AggregatingMergeTree MVs, no Nullables, monthly partitioning, Bloom filters |
| 009 | [Scaling Readiness Assessment](ADR-009-scaling-readiness.md) | 2026-03-17 | Bottleneck thresholds, 5-stage scaling path, horizontal readiness, 429 strategy |
