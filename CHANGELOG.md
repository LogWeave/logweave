# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

LogWeave has not yet had a tagged release. Everything listed below is on `main`
and ships in the first release (planned as 0.1.0). This section will be split
into a dated `0.1.0` heading when we tag.

### Core

- **Pattern clustering** — Drain3-powered log template extraction with per-tenant sensitivity tuning
- **Real-time dashboard** — KPIs, volume chart, pattern table, service health, live tail
- **Onboarding flow** — 3-step checklist: Send Logs, Connect AI, Tune Clustering
- **Alerting** — Threshold rules + pattern watches with Slack, PagerDuty, and webhook channels
- **S3 raw log drill-down** — Regex-matched log retrieval from customer S3 buckets
- **Deploy markers** — Anchor change detection to deployments
- **Custom metadata tags** — Configurable field extraction with tag-based search
- **Anomaly detection** — Z-score outlier detection per service against a 7-day baseline matched by hour-of-day (see ADR-014)
- **Cross-service correlation** — Pearson r correlation and co-occurrence analysis
- **Log cost optimizer** — Identify noisy, high-volume patterns; classify by volume percentage and level
- **Server-side log-level filtering** — Drop unwanted log levels at ingestion before storage

### MCP server (`@logweave/mcp`)

- 26 production tools (plus 3 dev-only tools behind `LOGWEAVE_DEV=1`) covering overview, error patterns, change detection, service diagnosis, template search (text + semantic), correlations, related patterns, traces, raw logs, live tail, deploys, cost optimizer, threshold rule creation, clustering health, period comparison, and more
- stdio transport, npm-publishable as `@logweave/mcp`

### Ingestion

- Winston SDK transport (`@logweave/transport`) — buffer, retry, never block
- HTTP batch API — any language
- OpenTelemetry Protocol (JSON)

### Authentication & Security

- Username/password login with forced password change on first login
- Random bootstrap admin password printed once to stderr on first start (`LOGWEAVE BOOTSTRAP` banner)
- Optional TOTP 2FA (Google Authenticator, Authy)
- Account lockout (5 attempts / 15 min)
- Admin/viewer roles with team management
- API key auth for SDK and MCP (separate from dashboard login), with runtime CRUD (no restart)
- scrypt password hashing with timing-safe comparison
- HMAC-signed session cookies (httpOnly, secure, sameSite)
- 30-minute idle session timeout with rolling cookie renewal
- Session version invalidation on password change
- AES-256-GCM encryption for connector secrets at rest
- HKDF domain-separated key derivation
- CSRF protection (double-submit cookie pattern) on all state-changing endpoints
- ClickHouse credentials enforced in production Docker Compose
- Audit trail for all authentication and data-access events (settings, connectors, rules, deploys)
- SECURITY.md with private vulnerability reporting policy

### Infrastructure

- Docker Compose dev and production configs with resource limits
- Health probes, graceful shutdown, circuit breaker
- Self-hosted install guide (5-minute setup)
- CloudFormation templates for AWS deployment (network + application stacks)
- Landing page for GitHub Pages

### Connectors

- Amazon S3 (IAM AssumeRole)
- Elasticsearch / OpenSearch (none, API key, or basic auth)
- Grafana Loki (optional bearer token)
- Local Filesystem (Docker volume mount)

### Tests

- Comprehensive test coverage across API and clusterer (1000+ test cases across 73+ files at the time of writing)
