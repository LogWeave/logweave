# Changelog

## 0.1.0 (2026-03-25) — Initial Pre-Release

### Features
- **Pattern clustering** — Drain3-powered log template extraction with per-tenant sensitivity tuning
- **21 MCP tools** — AI-native production intelligence (diagnose, correlate, search, tail, alert)
- **Real-time dashboard** — KPIs, volume chart, pattern table, service health, live tail
- **Onboarding flow** — 3-step checklist: Send Logs, Connect AI, Tune Clustering
- **Alerting** — Threshold rules + pattern watches with Slack, PagerDuty, and webhook channels
- **Authentication** — Username/password login, TOTP 2FA, team management, admin/viewer roles
- **S3 raw log drill-down** — Regex-matched log retrieval from customer S3 buckets
- **Deploy markers** — Anchor change detection to deployments
- **Custom metadata tags** — Configurable field extraction with tag-based search
- **Anomaly detection** — Z-score outlier detection per service against 7-day baseline
- **Cross-service correlation** — Pearson r correlation and co-occurrence analysis

### Ingestion
- Winston SDK transport (`@logweave/transport`)
- HTTP batch API (any language)
- OpenTelemetry Protocol (JSON)

### Security
- scrypt password hashing with timing-safe comparison
- HMAC-signed session cookies (httpOnly, secure, sameSite)
- AES-256-GCM encryption for secrets at rest
- HKDF domain-separated key derivation
- Account lockout (5 attempts / 15 min)
- Audit trail for all authentication events
- Session version invalidation on password change

### Infrastructure
- Docker Compose production config with resource limits
- Self-hosted install guide (5-minute setup)
- Health probes, graceful shutdown, circuit breaker
- 741+ automated tests across API and clusterer
