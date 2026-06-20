# LogWeave API Reference

Base URL: `http://localhost:3000` (default)

All authenticated endpoints require either:
- **API key**: `Authorization: Bearer <key>` header
- **Session cookie**: Set by `POST /v1/auth/session`

Responses from dashboard, composite, correlation, raw-logs, and tag endpoints use a standard envelope:

```json
{
  "data": { ... },
  "meta": {
    "hours": 24,
    "count": 10,
    "fetchedAt": "2026-03-26T12:00:00.000Z",
    "timeRange": "last 24 hours",
    "dataRetention": "30 days"
  }
}
```

Other endpoints use `{ "data": { ... }, "meta": { ... } }` or `{ "data": [ ... ], "meta": { ... } }` without time-range metadata.

Error responses use `{ "error": { "code": "...", "message": "..." } }`.

---

## Table of Contents

1. [Health and Metrics](#health-and-metrics)
2. [Authentication](#authentication)
3. [Ingestion](#ingestion)
4. [Dashboard](#dashboard)
5. [Templates](#templates)
6. [Composite Endpoints](#composite-endpoints)
7. [Correlation](#correlation)
8. [Live Tail](#live-tail)
9. [Watches](#watches)
10. [Alert Rules](#alert-rules)
11. [Deploys](#deploys)
12. [Connectors](#connectors)
13. [Raw Logs](#raw-logs)
14. [Tags](#tags)
15. [Settings](#settings)

---

## Health and Metrics

These endpoints are unauthenticated.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness probe. Always returns `{ "status": "ok" }`. |
| GET | `/readyz` | Readiness probe. Pings ClickHouse; returns clusterer status, circuit breaker state, and metrics. Returns 503 if ClickHouse is down. |
| GET | `/metrics` | Prometheus exposition format. Counters for events ingested/dropped/clustered, insert latency, anomaly scores, recovery stats, and process uptime. |

### GET /readyz response

```json
{
  "status": "ready",
  "clickhouse": "ok",
  "clusterer": {
    "status": "ok | degraded",
    "consecutiveFailures": 0,
    "circuitOpen": false
  },
  "metrics": { ... }
}
```

---

## Authentication

All auth routes are mounted at `/v1/auth/*`. Session-based auth uses a `logweave_sid` HttpOnly cookie.

### POST /v1/auth/session

Login. Creates a session cookie.

**Auth**: None

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | yes | 1-128 chars |
| `password` | string | yes | min 1 char |
| `totpCode` | string | no | 6-digit TOTP code or recovery code (if TOTP enabled) |

**Response** (200): `{ data: { userId, username, tenantId, role, mustChangePassword, totpEnabled } }`

**Errors**: 401 `INVALID_CREDENTIALS`, 429 `LOCKED_OUT` (with `Retry-After` header)

### DELETE /v1/auth/session

Logout. Clears session cookie.

**Auth**: None (clears cookie regardless)

**Response**: 204 No Content

### GET /v1/auth/me

Check current session.

**Auth**: Session cookie

**Response** (200): `{ data: { userId, username, tenantId, role, mustChangePassword, totpEnabled } }`

**Errors**: 401 `NOT_AUTHENTICATED`, 401 `SESSION_INVALID`

### PUT /v1/auth/password

Change own password.

**Auth**: Session cookie

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `currentPassword` | string | yes | Current password |
| `newPassword` | string | yes | New password (min 12 chars, policy enforced) |

**Response** (200): `{ data: { changed: true } }`

**Errors**: 400 `WEAK_PASSWORD`, 401 `INVALID_CREDENTIALS`

### POST /v1/auth/totp/setup

Generate TOTP QR code for setup.

**Auth**: Session cookie

**Response** (200): `{ data: { qrCodeDataUrl, secret, uri } }`

### POST /v1/auth/totp/confirm

Confirm TOTP setup with a verification code. Returns recovery codes.

**Auth**: Session cookie

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | yes | Exactly 6 digits |

**Response** (200): `{ data: { enabled: true, recoveryCodes: ["..."] } }`

**Errors**: 400 `NO_TOTP_PENDING`, 400 `INVALID_CODE`

### DELETE /v1/auth/totp

Disable TOTP.

**Auth**: Session cookie

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `password` | string | yes | Account password for confirmation |

**Response** (200): `{ data: { enabled: false } }`

### GET /v1/auth/users

List users in the caller's tenant.

**Auth**: Session cookie (admin role required)

**Response** (200): `{ data: [{ userId, username, tenantId, role, totpEnabled, lastLoginAt }] }`

### POST /v1/auth/users

Create a user in the caller's tenant.

**Auth**: Session cookie (admin role required)

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | yes | 1-128 chars, alphanumeric + `_.-` |
| `password` | string | yes | min 12 chars |
| `tenantId` | string | yes | Must match caller's tenant |
| `role` | string | yes | `"admin"` or `"viewer"` |

**Response** (201): `{ data: { userId, username, tenantId, role } }`

**Errors**: 403 `FORBIDDEN`, 409 `USERNAME_TAKEN`

### DELETE /v1/auth/users/:id

Delete a user.

**Auth**: Session cookie (admin role required)

**Errors**: 400 `CANNOT_DELETE_SELF`, 404 `NOT_FOUND`

**Response**: 204 No Content

### PUT /v1/auth/users/:id/password

Reset another user's password (admin only).

**Auth**: Session cookie (admin role required)

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `newPassword` | string | yes | min 12 chars |

**Response** (200): `{ data: { reset: true } }`

---

## Ingestion

All ingestion routes require API key auth and are rate-limited separately from query endpoints.

### POST /v1/ingest/batch

Ingest a batch of log events (LogWeave SDK format).

**Auth**: API key

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `events` | array | yes | 1-1000 log event objects |
| `service` | string | no | Default service name |
| `environment` | string | no | Default environment |
| `neverExtract` | string[] | no | Field names to exclude from extraction |
| `source_type` | string | no | Source identifier (max 64 chars) |
| `source_ref` | string | no | Source reference/URI (max 1024 chars) |

**Response** (200):

```json
{
  "accepted": 100,
  "clustered": 98,
  "unclustered": 2,
  "new_templates": 5
}
```

### POST /v1/ingest/logs

Generic log ingestion. Accepts a single JSON object or an array. Auto-detects field names.

**Auth**: API key

**Request body**: A JSON object (single event) or JSON array of events. Max 1000 events.

**Response** (200): Same shape as `/ingest/batch`.

### POST /v1/logs

OpenTelemetry OTLP/JSON log ingestion. Accepts gzip-compressed bodies. Rejects protobuf encoding.

**Auth**: API key

**Request body**: OTLP `ExportLogsServiceRequest` JSON structure. Max 5MB (compressed or uncompressed). Max 1000 flattened events.

**Response** (200): OTLP-spec response:

```json
{
  "partialSuccess": {
    "rejectedLogRecords": 0,
    "errorMessage": ""
  }
}
```

**Errors**: 415 `UNSUPPORTED_MEDIA_TYPE` (protobuf not supported)

---

## Dashboard

All dashboard routes require API key or session auth.

### GET /v1/dashboard/templates

List top templates by occurrence.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `limit` | int | 100 | Max results (1-1000) |
| `service` | string | - | Filter by service name |
| `sort` | string | `occurrence` | Sort by: `occurrence`, `error`, `recent` |
| `level` | string | - | Comma-separated level filter (e.g., `ERROR,WARN`) |

**Response data**: Array of `TemplateRow`:

| Field | Type | Description |
|-------|------|-------------|
| `templateId` | string | UUIDv7 |
| `templateText` | string | Drain3 template pattern |
| `service` | string | Service name |
| `occurrenceCount` | number | Event count |
| `errorCount` | number | Error-level count |
| `avgDurationMs` | number | Average duration |
| `maxAnomalyScore` | number | Peak anomaly score |
| `isNewToday` | boolean | First seen within 24h |
| `firstSeen` | string | ISO timestamp |
| `lastSeen` | string | ISO timestamp |

### GET /v1/dashboard/services

List services with metrics.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `limit` | int | 100 | Max results (1-100) |
| `level` | string | - | Comma-separated level filter |

**Response data**: Array of `ServiceRow`:

| Field | Type | Description |
|-------|------|-------------|
| `service` | string | Service name |
| `logCount` | number | Total events |
| `errorCount` | number | Error-level count |
| `warnCount` | number | Warn-level count |
| `errorRate` | number | Error ratio (0-1, 4 decimal places) |
| `warnRate` | number | Warn ratio |
| `newTemplateCount` | number | New templates in window |
| `avgAnomalyScore` | number | Average anomaly score |

### GET /v1/dashboard/volume

Time-series volume data with optional previous-period comparison.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `service` | string | - | Filter by service |
| `offset` | int | 0 | Offset hours for comparison period (0-720) |
| `level` | string | - | Comma-separated level filter |

**Response data**: `{ current: VolumePoint[], previous?: VolumePoint[] }`

Each `VolumePoint`: `{ intervalStart, service, logCount, errorCount }`

### GET /v1/dashboard/overview

Aggregate overview metrics with optional period-over-period comparison.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `level` | string | - | Comma-separated level filter |
| `compare` | string | `false` | Set to `true` for previous-period comparison |

**Response data**: `OverviewData`:

| Field | Type | Description |
|-------|------|-------------|
| `totalEvents` | number | Total events in window |
| `totalTemplates` | number | Unique template count |
| `newTemplatesToday` | number | Templates first seen today |
| `unclusteredCount` | number | Events with template_id=0 |
| `errorRate` | number | Error ratio (0-1) |
| `serviceCount` | number | Distinct services |
| `previous` | object | Same fields for comparison period (when `compare=true`) |

### GET /v1/dashboard/template-sparklines

Mini time-series for specific templates (for inline charts).

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `templateIds` | string | - | **Required.** Comma-separated template IDs (1-20) |
| `level` | string | - | Comma-separated level filter |

**Response data**: `{ [templateId]: [{ intervalStart, count }] }`

### GET /v1/dashboard/clustering-health

Clustering pipeline health metrics and trend.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `level` | string | - | Comma-separated level filter |

**Response data**: `ClusteringHealthData`:

| Field | Type | Description |
|-------|------|-------------|
| `totalEvents` | number | Total events |
| `clusteredEvents` | number | Successfully clustered |
| `unclusteredEvents` | number | Failed clustering |
| `uniqueTemplates` | number | Distinct templates |
| `compressionRatio` | number | templates / events |
| `trend` | array | `[{ intervalStart, total, unclustered, ratio }]` |

### GET /v1/dashboard/changes

Detect new, spiking, and resolved templates. Can anchor to a deploy marker.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `since` | string | - | ISO datetime; overrides `hours` |
| `deployId` | string | - | Deploy marker ID; resolves to its timestamp |
| `service` | string | - | Filter by service |
| `threshold` | number | 3 | Spike ratio threshold (1-100) |
| `minBaseline` | int | 10 | Min previous-window count for a template to qualify as a spike (0-10000) |
| `limit` | int | 20 | Max results per category (1-100) |
| `level` | string | - | Comma-separated level filter |

**Response data**:

```json
{
  "new": [ChangeEvent],
  "spike": [ChangeEvent],
  "resolved": [ChangeEvent]
}
```

Each `ChangeEvent`: `{ type, templateId, templateText, service, currentCount, previousCount, ratio, firstSeen?, lastSeen? }`

### GET /v1/dashboard/levels

Log level distribution.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `service` | string | - | Filter by service |

**Response data**: `[{ level, count }]`

### GET /v1/dashboard/template-status-codes

HTTP status code distribution for a template.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `templateId` | string | - | **Required.** Template ID |
| `since` | string | - | ISO datetime lower bound |
| `until` | string | - | ISO datetime upper bound |

**Response data**: `[{ statusCode, count }]`

---

## Templates

### GET /v1/templates/search

Search templates by substring or semantic similarity.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | - | **Required.** Search query (min 3 chars) |
| `hours` | int | 24 | Time window (1-720) |
| `limit` | int | 100 | Max results (1-1000) |
| `level` | string | - | Comma-separated level filter |
| `mode` | string | `substring` | `substring` or `semantic` |

**Response data**: Array of:

| Field | Type |
|-------|------|
| `templateId` | string |
| `templateText` | string |
| `servicesAffected` | string[] |
| `occurrenceCount` | number |
| `errorCount` | number |
| `avgDurationMs` | number |
| `maxAnomalyScore` | number |
| `firstSeen` | string |
| `lastSeen` | string |

### GET /v1/templates/:id/trend

Daily trend for a specific template over up to 365 days.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `days` | int | 90 | Lookback in days (1-365) |

**Response data**: `[{ day, occurrenceCount, errorCount, avgDurationMs, maxAnomalyScore }]`

### GET /v1/templates/:id/events

Individual log events for a template (drill-down).

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `statusCode` | int | - | Filter by HTTP status code |
| `since` | string | - | ISO datetime lower bound |
| `until` | string | - | ISO datetime upper bound |
| `limit` | int | 20 | Max results (1-100) |

**Response data**: `[{ timestamp, traceId, route, durationMs, level, service, statusCode }]`

### GET /v1/templates/:id/related

Templates that co-occur in the same traces.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `limit` | int | 20 | Max results (1-100) |

**Response data**: `[{ templateId, templateText, service, coOccurrenceCount }]`

### GET /v1/templates/:id/correlations

Pearson correlation of hourly volume with other templates.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `limit` | int | 10 | Max results (1-50) |

**Response data**: `[{ templateId, templateText, coefficient, direction, occurrenceCount }]`

- `direction`: `"positive"` or `"negative"`
- `coefficient`: Pearson r, rounded to 3 decimal places

### GET /v1/templates/:id/raw-logs

Fetch raw log lines from S3 connector matching a template pattern.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `service` | string | - | **Required.** Service name |
| `hours` | int | 1 | Time window (1-24) |
| `limit` | int | 50 | Max lines (1-100) |
| `connectorId` | string | - | Specific connector; uses first available if omitted |

**Response data**:

| Field | Type | Description |
|-------|------|-------------|
| `lines` | array | `[{ message, timestamp?, source, sourceUrl? }]` |
| `filesScanned` | number | S3 objects read |
| `bytesScanned` | number | Total bytes read |
| `truncated` | boolean | Whether scan was cut short |
| `truncatedReason` | string | Reason if truncated |

---

## Composite Endpoints

Single-call endpoints that combine multiple queries. Designed for MCP tools and external API consumers to reduce round-trips.

### GET /v1/templates/:id/detail

Full template detail: metadata + sparkline + status code breakdown.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `level` | string | - | Comma-separated level filter |

**Response data**: `TemplateDetailData`:

| Field | Type |
|-------|------|
| `templateId` | string |
| `templateText` | string (truncated to 200 chars) |
| `truncated` | boolean |
| `servicesAffected` | string[] |
| `occurrenceCount` | number |
| `errorCount` | number |
| `avgDurationMs` | number |
| `maxAnomalyScore` | number |
| `firstSeen` | string |
| `lastSeen` | string |
| `sparkline` | `[{ intervalStart, count }]` |
| `statusCodes` | `[{ statusCode, count }]` |

**Errors**: 404 `NOT_FOUND`

### GET /v1/services/:name/health

Service health overview: metrics + top error patterns + volume trend.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `level` | string | - | Comma-separated level filter |

**Response data**: `ServiceHealthData`:

| Field | Type |
|-------|------|
| `service` | string |
| `logCount` | number |
| `errorCount` | number |
| `warnCount` | number |
| `errorRate` | number |
| `warnRate` | number |
| `topErrorPatterns` | `CrossServiceTemplate[]` |
| `volumeTrend` | `[{ intervalStart, logCount, errorCount }]` |

**Errors**: 404 `NOT_FOUND`

### GET /v1/overview

System-wide overview: aggregate metrics + top error patterns.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `level` | string | - | Comma-separated level filter |

**Response data**: `OverviewCompositeData`:

| Field | Type |
|-------|------|
| `totalEvents` | number |
| `totalTemplates` | number |
| `newTemplatesToday` | number |
| `unclusteredCount` | number |
| `errorRate` | number |
| `serviceCount` | number |
| `topErrorPatterns` | `CrossServiceTemplate[]` |

---

## Correlation

### GET /v1/traces/:traceId

All log events sharing a trace ID, ordered chronologically.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |

**Response data**: `[{ service, templateId, templateText, level, timestamp, statusCode, durationMs, route }]`

**Errors**: 404 `NOT_FOUND`

### GET /v1/services/:name/outlier

Z-score analysis of a service's current error rate vs. its baseline.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 1 | Current window for comparison (1-168) |

**Response data**: `ServiceOutlier`:

| Field | Type | Description |
|-------|------|-------------|
| `service` | string | Service name |
| `currentRate` | number | Current error rate |
| `currentErrors` | number | Error count in window |
| `currentLogs` | number | Total logs in window |
| `baselineMean` | number | Historical mean error rate |
| `baselineStddev` | number | Historical standard deviation |
| `zScore` | number | (current - mean) / stddev |
| `verdict` | string | `"normal"`, `"elevated"` (z>1.5), or `"outlier"` (z>2.0) |
| `dataPoints` | number | Hourly data points available |
| `warning` | string | Present if <168 data points |

---

## Live Tail

Real-time log event streaming via SSE or cursor-based polling.

### POST /v1/tail/token

Exchange an API key for a short-lived SSE token. The token is used as a query parameter on the SSE endpoint.

**Auth**: API key or session

**Response** (200): `{ data: { token: "..." }, meta: { fetchedAt } }`

### GET /v1/tail

Server-Sent Events (SSE) stream of live log events.

**Auth**: `?token=<tail-token>` (from `POST /tail/token`)

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string | - | **Required.** Tail token |
| `service` | string | - | Filter by service |
| `level` | string | - | Filter by exact level |
| `minLevel` | string | - | Minimum severity level |
| `templateId` | string | - | Filter by template ID |
| `minAnomaly` | number | - | Minimum anomaly score (0 = normal, ≥1.0 = anomalous, no upper bound) |

**SSE events**: Each `data:` line contains a `TailEvent` JSON object. Supports `Last-Event-ID` for reconnection replay.

**Special events**: `event: gap` (missed events), `event: error` (backpressure), `event: shutdown` (server stopping)

**Errors**: 401 (invalid/expired token), 403 `TAIL_DISABLED`, 429 `CONNECTION_LIMIT`

### GET /v1/tail/poll

Cursor-based polling alternative to SSE (for MCP tools).

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `seconds` | int | 30 | Lookback window for initial fetch (1-60) |
| `limit` | int | 50 | Max events (1-200) |
| `cursor` | int | - | Sequence number; returns events after this cursor |
| `service` | string | - | Filter by service |
| `level` | string | - | Filter by exact level |
| `minLevel` | string | - | Minimum severity level |
| `templateId` | string | - | Filter by template ID |
| `minAnomaly` | number | - | Minimum anomaly score (0 = normal, ≥1.0 = anomalous, no upper bound) |

**Response** (200):

```json
{
  "data": {
    "events": [TailEvent],
    "cursor": 12345,
    "gap": false,
    "missedEstimate": 0
  },
  "meta": { "count": 10, "fetchedAt": "..." }
}
```

### GET /v1/tail/stats

Tail buffer utilization metrics.

**Auth**: API key or session

**Response** (200): `{ data: { ...bufferStats, connectionsActive }, meta: { fetchedAt } }`

---

## Watches

Simple template watch list (triggers Slack notifications for watched templates).

### POST /v1/watches

Add a template to the watch list.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `templateId` | string | yes | Template ID to watch |
| `templateText` | string | no | Template text (max 2000 chars) |

**Response** (201): `{ data: { templateId }, meta: { fetchedAt } }`

**Errors**: 400 `WATCH_LIMIT_EXCEEDED` (max 100 per tenant)

### GET /v1/watches

List watched template IDs.

**Auth**: API key or session

**Response** (200): `{ data: [{ templateId }], meta: { count, fetchedAt } }`

### DELETE /v1/watches/:templateId

Remove a template from the watch list.

**Auth**: API key or session

**Response**: 204 No Content

---

## Alert Rules

Configurable alert rules with threshold and template-watch types.

### POST /v1/rules

Create an alert rule.

**Auth**: API key or session

**Request body** (discriminated union on `ruleType`):

For `threshold` rules:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Rule name (1-256 chars) |
| `ruleType` | `"threshold"` | yes | |
| `enabled` | boolean | no | Default: `true` |
| `config.metric` | string | yes | `error_count`, `warn_count`, or `log_count` |
| `config.service` | string | yes | Service to monitor |
| `config.operator` | string | yes | `>`, `>=`, `<`, `<=` |
| `config.value` | number | yes | Threshold value (positive) |
| `config.windowMinutes` | int | yes | Evaluation window (1-60 min) |
| `config.environment` | string | no | Optional environment filter |
| `channels` | string[] | no | Webhook URLs or `pagerduty://{key}` (max 10) |
| `cooldownMinutes` | int | no | Minimum time between alerts (1-1440) |

For `template_watch` rules:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Rule name (1-256 chars) |
| `ruleType` | `"template_watch"` | yes | |
| `enabled` | boolean | no | Default: `true` |
| `config.templateId` | string | yes | Template ID to watch |
| `config.templateText` | string | yes | Template text (max 2000 chars) |
| `channels` | string[] | no | Notification channels (max 10) |
| `cooldownMinutes` | int | no | Minimum time between alerts (1-1440) |

**Response** (201): `{ data: { ruleId, name, ruleType, enabled, config, channels, cooldownMinutes }, meta: { fetchedAt } }`

**Errors**: 400 `RULE_LIMIT_EXCEEDED`

### GET /v1/rules

List all rules for the tenant.

**Auth**: API key or session

**Response** (200): `{ data: [Rule], meta: { count, fetchedAt } }`

### PUT /v1/rules/:id

Update a rule. All fields optional; config must match existing rule type.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | |
| `enabled` | boolean | no | |
| `config` | object | no | Must match rule type |
| `channels` | string[] | no | |
| `cooldownMinutes` | int | no | |

**Response** (200): Updated rule object.

**Errors**: 400 `CONFIG_TYPE_MISMATCH`, 404 `NOT_FOUND`

### DELETE /v1/rules/:id

Delete a rule.

**Auth**: API key or session

**Response**: 204 No Content

### GET /v1/alerts

Query alert history.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `hours` | int | 24 | Time window (1-720) |
| `ruleId` | string | - | Filter by rule ID |
| `service` | string | - | Filter by service |
| `limit` | int | 100 | Max results (1-500) |

**Response** (200): `{ data: [{ alertId, ruleId, ruleType, ruleName, firedAt, metricValue, thresholdValue, details, channelsNotified }], meta: { count, hours, fetchedAt } }`

---

## Deploys

Deploy markers for correlating code changes with log pattern shifts.

### POST /v1/deploys

Create a deploy marker.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `service` | string | yes | Service name (1-128 chars) |
| `version` | string | no | Version string (max 256 chars) |
| `commitSha` | string | no | Git commit SHA (max 64 chars) |
| `timestamp` | string | no | ISO datetime; defaults to now |

**Response** (201): `{ data: { deployId, service, version, commitSha, timestamp }, meta: { fetchedAt } }`

### GET /v1/deploys

List recent deploys.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `service` | string | - | Filter by service |
| `limit` | int | 10 | Max results (1-50) |

**Response** (200): `{ data: [{ deployId, service, version, commitSha, timestamp }], meta: { count, limit, fetchedAt } }`

---

## Connectors

S3 log source connectors for raw log drill-down.

### POST /v1/connectors

Create a connector. Credentials are encrypted at rest.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name (1-128 chars) |
| `config.type` | `"s3"` | yes | Connector type |
| `config.bucket` | string | yes | S3 bucket name (3-63 chars) |
| `config.prefix` | string | no | Key prefix (default: `""`) |
| `config.pathPattern` | string | yes | Path pattern (1-1024 chars) |
| `config.region` | string | yes | AWS region (1-64 chars) |
| `config.logFormat` | string | yes | `"jsonl"` or `"text"` |
| `config.compression` | string | yes | `"none"` or `"gzip"` |
| `config.endpoint` | string | no | Custom S3-compatible endpoint (dev only; blocked in production) |
| `config.forcePathStyle` | boolean | no | Path-style S3 access |
| `config.accessKeyId` | string | no | Static access key (dev only — production uses AssumeRole) |
| `config.secretAccessKey` | string | no | Static secret key (dev only — production uses AssumeRole) |

**Response** (201): `{ data: { connectorId, name, type, config (redacted) }, meta: { fetchedAt } }`

### GET /v1/connectors

List connectors. Credentials are redacted in response.

**Auth**: API key or session

**Response** (200): `{ data: [{ connectorId, name, type, config (redacted), createdAt }], meta: { count, fetchedAt } }`

### POST /v1/connectors/:id/test

Test connector connectivity by listing S3 objects.

**Auth**: API key or session

**Response** (200): `{ data: { success, ... }, meta: { fetchedAt } }`

**Errors**: 404 `NOT_FOUND`

### DELETE /v1/connectors/:id

Delete a connector.

**Auth**: API key or session

**Response**: 204 No Content

**Errors**: 404 `NOT_FOUND`

---

## Tags

Query log events by custom tag key/value pairs.

### GET /v1/events/by-tag

Find events matching a tag.

**Auth**: API key or session

**Query parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `key` | string | - | **Required.** Tag key (1-64 chars) |
| `value` | string | - | **Required.** Tag value (1-256 chars) |
| `hours` | int | 24 | Time window (1-720) |
| `limit` | int | 50 | Max results (1-200) |

**Response data**: `[{ eventId, templateId, service, level, timestamp, tagKey, tagValue }]`

---

## Settings

Tenant configuration for Slack, tags, clustering, and onboarding.

### GET /v1/settings/slack

Check Slack webhook configuration status. Never exposes the URL.

**Auth**: API key or session

**Response** (200): `{ data: { configured, lastTestStatus, lastTestAt }, meta: { fetchedAt } }`

### POST /v1/settings/slack

Store a Slack webhook URL.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhookUrl` | string | yes | Must start with `https://hooks.slack.com/` |

**Response** (200): `{ data: { configured: true }, meta: { fetchedAt } }`

### DELETE /v1/settings/slack

Remove Slack webhook configuration.

**Auth**: API key or session

**Response**: 204 No Content

### POST /v1/settings/slack/test

Send a test message to the configured Slack webhook.

**Auth**: API key or session

**Response** (200): `{ data: { success, failureReason? }, meta: { fetchedAt } }` — `failureReason` is present only when `success` is `false`.

**Errors**: 400 `SLACK_NOT_CONFIGURED`

### GET /v1/settings/tags

Get configured tag extraction keys.

**Auth**: API key or session

**Response** (200): `{ data: { extractTags: ["key1", "key2"] }, meta: { fetchedAt } }`

### PUT /v1/settings/tags

Update tag extraction keys.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `extractTags` | string[] | yes | Tag keys to extract (max 20). Alphanumeric + `_.-`. Reserved names blocked: message, msg, log, body, raw, text, content |

**Response** (200): `{ data: { extractTags }, meta: { fetchedAt } }`

### GET /v1/settings/clustering

Get current clustering sensitivity.

**Auth**: API key or session

**Response** (200): `{ data: { sensitivity: 0.5 | null }, meta: { fetchedAt } }`

### PUT /v1/settings/clustering

Update clustering sensitivity.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sensitivity` | number | yes | 0.2 - 0.8 |

**Response** (200): `{ data: { sensitivity }, meta: { fetchedAt } }`

### POST /v1/settings/clustering/preview

Dry-run clustering on recent logs with a proposed sensitivity.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sensitivity` | number | yes | 0.2 - 0.8 |

**Response** (200): `{ data: { patternCount, compressionRatio, sampleTemplates }, meta: { fetchedAt, sampleSize? } }`

### POST /v1/settings/clustering/reset

Reset the Drain3 miner for the tenant and update sensitivity.

**Auth**: API key or session

**Request body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sensitivity` | number | yes | 0.2 - 0.8 |

**Response** (200): `{ data: { sensitivity, cleared }, meta: { fetchedAt } }`

### GET /v1/settings/onboarding-status

Lightweight onboarding progress check.

**Auth**: API key or session

**Response** (200):

```json
{
  "data": {
    "hasEvents": true,
    "mcpConnected": false,
    "clusteringConfigured": true,
    "dismissed": false
  },
  "meta": { "fetchedAt": "..." }
}
```

### POST /v1/settings/onboarding/dismiss

Mark onboarding as dismissed (idempotent).

**Auth**: API key or session

**Response** (200): `{ data: { dismissed: true }, meta: { fetchedAt } }`

---

## Rate Limiting

All authenticated endpoints are rate-limited. Three tiers:

1. **Per API key** (`X-RateLimit-Limit`, `X-RateLimit-Remaining`): configurable RPM per key
2. **Per tenant**: aggregate RPM across all keys for a tenant
3. **Ingest endpoints**: separate, higher RPM limit

When rate-limited, the API returns `429 Too Many Requests` with a `Retry-After` header.

## Concurrent Query Guard

Dashboard and query endpoints are protected by a concurrent query limit per tenant. When the limit is reached, queries return `429 Too Many Requests`.

## CSRF Protection

Mutating requests from session-authenticated users require a CSRF token (set via `X-CSRF-Token` response header, submitted via `X-CSRF-Token` request header). API key authenticated requests are exempt.
