# ADR-010: Secure Log Source Connectors for Raw Log Drill-Down

**Status:** Accepted
**Date:** 2026-03-19

## Context

LogWeave stores only metadata and patterns, never raw log content (see ADR-002). When
users investigate a spike or anomaly in the dashboard, they need to see the actual log
lines that produced it. Raw logs live in the customer's infrastructure (S3, CloudWatch,
etc.). We need on-demand, read-only access to customer log stores without violating our
"no raw log storage" principle.

The SRE persona postmortem rated this as the #1 reason a user would cancel: "no raw log
storage is interpreted as no raw log access." Users need a "View in Source" capability.

## Decision

### MVP: S3 + AssumeRole + Proxy Model

**Connector target:** Amazon S3 (covers ~70% of small-to-mid teams who route logs via
CloudWatch/Fluentd to S3).

**Authentication:** Cross-account IAM AssumeRole with ExternalId.
- Industry standard approach (used by Datadog, Grafana Cloud, New Relic)
- No long-lived secrets stored — temporary credentials with 1-hour TTL
- Customer controls access scope via their IAM policy
- ExternalId (UUID generated per connector) prevents confused deputy attacks
- We store per tenant: `roleArn`, `externalId`, `region`, `bucket`, `prefix`

**Data flow:** API-proxied (browser never touches customer S3 directly).
```
Browser → LogWeave API → STS AssumeRole → Customer S3 → filter → stream response
```
- Eliminates CORS configuration on customer S3 buckets
- All access auditable in LogWeave API logs
- Rate limited: 10 requests/min, 3 concurrent, 100 lines max, 10MB response cap

**Credential storage:** Envelope encryption in ClickHouse.
- Master key from `LOGWEAVE_MASTER_KEY` env var (required when connectors enabled)
- Per-record AES-256-GCM with random data encryption key (DEK)
- DEK encrypted with master key and stored alongside ciphertext
- New `logweave.tenant_connectors` table (ReplacingMergeTree)
- Credential fields redacted from all pino log output

**Query translation:**
- `template_text` converted to S3 Select SQL LIKE pattern for server-side pre-filtering
- Secondary regex filter applied in the API for higher precision
- Time scoping derived from dashboard context (hours param + firstSeen/lastSeen)

### Pluggable Architecture

Build the S3 connector as a concrete implementation first. Extract a `LogSourceConnector`
interface when connector #2 (CloudWatch) arrives. Do not over-abstract upfront.

### Future Connectors (Not MVP)

| Connector | Target Milestone | Notes |
|-----------|-----------------|-------|
| CloudWatch Logs | Week 4-5 | CloudWatch Insights query via assumed role |
| Elasticsearch | Post-MVP | API key or basic auth |
| Customer-side agent | Maybe never | Complexity vs. value unclear |

## Security Constraints

1. **SSRF prevention:** Validate bucket names against S3 naming rules, reject private IP
   ranges and non-S3 endpoints
2. **No credential leakage:** Never include roleArn, accessKeyId, or secretAccessKey in
   error messages, logs, or API responses
3. **Least privilege:** Document IAM policy template with read-only access to specific
   bucket/prefix only
4. **Audit trail:** Log all connector access (tenant, connector_id, timestamp, rows_returned)
5. **Rate limiting:** Per-tenant rate limits on drill-down requests to prevent abuse
6. **Response size cap:** 10MB max to prevent OOM from large S3 objects

## Estimated Effort

| Phase | Hours | Description |
|-------|-------|-------------|
| Connector config + encryption | 6 | Table, CRUD API, envelope encryption |
| S3 read path | 12 | STS AssumeRole, S3 Select, streaming |
| Query translation | 4 | template_text to S3 Select patterns |
| Dashboard panel | 4 | "View Raw Logs" in template detail |
| Security hardening | 4 | SSRF, rate limiting, audit logging |
| Connection test + setup guide | 2 | Verify connectivity, onboarding UX |
| **Total** | **32** | ~4 working days |

## Alternatives Considered

1. **Pre-signed URLs (direct browser access):** Eliminates proxy bandwidth cost but
   requires CORS on customer buckets, exposes S3 structure to browser, harder to audit.
   Kept as fallback if proxy bandwidth becomes a bottleneck.

2. **Long-lived IAM access keys:** Simpler to implement but violates AWS security best
   practices. Only consider if a paying customer explicitly requires it and cannot
   configure AssumeRole.

3. **Customer-side agent:** Maximum security (customer controls all access) but massive
   operational complexity. Not viable for MVP.

## Consequences

- Customers must configure an IAM role in their AWS account (documented setup guide)
- LogWeave API server needs AWS SDK dependency (`@aws-sdk/client-s3`, `@aws-sdk/client-sts`)
- `LOGWEAVE_MASTER_KEY` env var becomes required when connectors feature is enabled
- Dashboard detail panel gets a "View Raw Logs" section (lazy-loaded, on-demand only)
- Raw log content is streamed through but never persisted — consistent with ADR-002
