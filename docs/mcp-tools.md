# LogWeave MCP Tools Reference

The LogWeave MCP server exposes 22 production tools and 3 dev-only tools via the
[Model Context Protocol](https://modelcontextprotocol.io). Connect any MCP-capable
LLM client (Claude, Cursor, etc.) and it can query your log intelligence data directly.

**Environment variables required:**

| Variable | Description |
|----------|-------------|
| `LOGWEAVE_API_URL` | Base URL of the LogWeave API server |
| `LOGWEAVE_API_KEY` | Tenant API key for authentication |
| `LOGWEAVE_DEV` | Set to `"true"` to enable dev-only tools |

---

## 1. Overview & Health

### `overview`

Get a high-level system health snapshot.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | number (optional) | 24 | Time window in hours (max 720) |

**Returns:** Total events, unique template count, new-today count, unclustered count,
error rate percentage, service count, and the top error patterns (template text, ID,
occurrence count, affected services).

**Use when:** Starting an investigation -- call this first to understand the current
state of the system.
**Do not use:** For specific service or template queries. Use `service_health` or
`template_detail` instead.

> Ask your AI: "Give me an overview of the last 6 hours"

---

### `clustering_health`

Check the health of the log clustering pipeline.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | | | |

**Returns:** Overall pipeline status, ClickHouse connectivity, clusterer circuit breaker
state (open/closed, consecutive failure count), and pipeline metrics (ingested, clustered,
unclustered counts).

**Use when:** Data seems stale, patterns are not updating, or you suspect the clustering
pipeline is down.

---

### `list_services`

List all services with key health indicators.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | number (optional) | 24 | Time window in hours |

**Returns:** For each service: name, log count, error count, error rate percentage,
and count of new patterns.

**Use when:** You need to discover which services exist, or want a quick ranking of
which services need attention. Start here when you need service names for
`service_health` or `diagnose_service`.

---

### `level_distribution`

Show the DEBUG/INFO/WARN/ERROR breakdown.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | number (optional) | 24 | Time window in hours |
| `service` | string (optional) | all | Filter to a specific service |

**Returns:** Count and percentage for each log level, plus total event count.

**Use when:** Looking for leading indicators of problems. A rising WARN percentage
often precedes error spikes.

---

## 2. Service Analysis

### `service_health`

Health report for a single service.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string | *(required)* | Service name to check |
| `hours` | number (optional) | 24 | Time window in hours |

**Returns:** Log count, error count and rate, warn count and rate, top error patterns
(template text, occurrence count), and a volume trend summary (direction, total, peak,
latest interval).

**Use when:** Checking whether a specific service is having problems.
**Do not use:** For cross-service overview. Use `overview` instead.

> Ask your AI: "How is payments-api doing?"

---

### `service_outlier`

Quick anomaly check for a service against its 7-day baseline.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string | *(required)* | Service name to check |
| `hours` | number (optional) | 1 | Current window for comparison (max 168) |

**Returns:** Verdict (`normal`, `elevated`, or `outlier`), z-score, current error rate,
baseline mean and standard deviation, and number of data points used. Includes
actionable guidance based on the verdict.

**Use when:** You want a fast yes/no answer on whether a service is misbehaving.
Use `service_health` for deeper investigation afterward.

---

### `diagnose_service`

Full diagnostic combining health + outlier + changes in one call.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string | *(required)* | Service name (use `list_services` to discover names) |
| `hours` | number (optional) | 24 | Time window in hours |

**Returns:** Outlier status with z-score, health metrics (log volume, error rate, warn
rate), top error patterns with template IDs, and recent changes (new patterns, spikes,
resolved patterns).

**Use when:** Investigating why a specific service is having problems. Saves three
separate tool calls.

> Ask your AI: "Diagnose payments-api"

---

## 3. Template / Pattern Analysis

### `error_patterns`

List error patterns sorted by occurrence count.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | number (optional) | 24 | Time window in hours |
| `service` | string (optional) | all | Filter to a specific service |
| `limit` | number (optional) | 100 | Max results to return |

**Returns:** For each error template: text, template ID, `[NEW]` badge if first seen
today, service name, total count, and error count.

**Use when:** You want to see what errors are happening across all services (or a
specific one).

---

### `search_templates`

Search for error patterns by text.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *(required)* | Search text (minimum 3 characters) |
| `hours` | number (optional) | 24 | Time window in hours |
| `limit` | number (optional) | 100 | Max results to return |
| `mode` | `"substring"` or `"semantic"` (optional) | `"substring"` | Search mode |

**Returns:** Matching templates with text, ID, occurrence count, and affected services.

**Use when:** You know (or roughly know) what an error message looks like.
Use `"semantic"` mode when the exact wording is unknown (e.g. "database slow" finds
"connection pool exhausted").

> Ask your AI: "Find patterns related to connection timeouts"

---

### `template_detail`

Deep dive on a specific error pattern.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `template_id` | string | *(required)* | Template ID (from `error_patterns`, `changes`, or `search_templates`) |
| `hours` | number (optional) | 24 | Time window in hours |

**Returns:** Template text, affected services, occurrence and error count, average
duration (ms), anomaly score, first/last seen timestamps, status code breakdown,
and occurrence trend with direction (trending UP / DOWN / stable), range, latest
and peak values.

**Do not use:** Without a valid `template_id`.

---

### `template_trend`

Long-term daily occurrence trend for a template.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `template_id` | string | *(required)* | Template ID |
| `days` | number (optional) | 90 | Days to look back (max 365) |

**Returns:** Trend direction (increasing / decreasing / stable), average daily count,
peak day and count, first-period average, recent-period average, and percentage change.

**Use when:** You need to determine if a pattern is getting worse over weeks or months,
or if it is seasonal.
**Do not use:** For short-term (hours) trends. Use `template_detail` instead.

---

### `template_events`

Get individual log events for a template pattern.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `template_id` | string | *(required)* | Template ID |
| `status_code` | number (optional) | all | Filter to a specific HTTP status code (e.g. 500) |
| `hours` | number (optional) | 24 | Time window in hours |
| `limit` | number (optional) | 20 | Max events to return (max 100) |

**Returns:** Table of events with timestamp, service, route, status code, duration (ms),
and trace ID.

**Use when:** You need to see specific event instances and collect trace IDs for
`trace_details`.

---

## 4. Changes & Deploys

### `changes`

See what changed recently: new, spiking, and resolved patterns.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | number (optional) | 24 | Time window (ignored if `since` or `deploy_id` is set) |
| `service` | string (optional) | all | Filter to a specific service |
| `since` | string (optional) | -- | ISO8601 timestamp to anchor comparison |
| `deploy_id` | string (optional) | -- | Deploy ID from `deploys` to anchor comparison |

**Returns:** Three sections -- new patterns (template text, ID, count, service), spikes
(template text, ID, ratio vs normal, current/previous counts, service), and resolved
patterns (template text, ID, previous count, service).

**Use when:** After a deploy, or to understand what is different from normal.
**Do not use:** For listing all errors. Use `error_patterns` instead.

> Ask your AI: "What changed since the last deploy of payments-api?"

---

### `deploys`

List recent deployments.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string (optional) | all | Filter to a specific service |
| `limit` | number (optional) | 10 | Max results to return |

**Returns:** For each deploy: service name, version, commit SHA (short), timestamp,
and deploy ID.

**Use when:** You need deploy IDs and timestamps for anchoring `changes` queries.

---

### `compare_periods`

Compare error patterns between two consecutive time windows.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string (optional) | all | Filter by service name |
| `recent_hours` | number | 2 | Length of the recent period in hours |
| `baseline_hours` | number | 2 | Length of the baseline period in hours (starts right after recent) |

**Returns:** Three sections -- new patterns (not in baseline), resolved patterns (not in
recent), and significant changes (>2x increase or >50% decrease) with a ratio and
direction indicator.

**Use when:** Spotting regressions or confirming a fix by comparing "before" vs "after".
**Do not use:** For deploy-anchored comparisons. Use `changes` with `deploy_id` instead.

---

## 5. Correlation & Investigation

### `trace_details`

Show all events sharing a trace ID across services.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `trace_id` | string | *(required)* | Trace ID from log events or error context |
| `hours` | number (optional) | 24 | Time window in hours (max 720) |

**Returns:** Event count, services involved, and a chronological timeline with
timestamp, service, level, status code, duration, and template text for each event.
Returns a friendly message (not an error) when the trace is not found.

**Use when:** You need to understand the full request flow when investigating an error.
**Do not use:** With guessed trace IDs. Get them from `template_events` or other results.

---

### `related_patterns`

Find patterns that co-occur in the same request traces (causal correlation).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `template_id` | string | *(required)* | Template ID to find related patterns for |
| `hours` | number (optional) | 24 | Time window in hours (max 720) |
| `limit` | number (optional) | 20 | Max results (max 100) |

**Returns:** Patterns that appear in the same traces as the given template, with
template text, co-occurrence count, and service.

**Use when:** Answering "what else happens when this error occurs?" within the same
request flow.

---

### `correlations`

Find patterns whose occurrence counts are statistically correlated (Pearson r >= 0.7).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `template_id` | string | *(required)* | Template ID to correlate against |
| `hours` | number (optional) | 24 | Time window in hours (max 720) |
| `limit` | number (optional) | 10 | Max results (max 50) |

**Returns:** Correlated patterns with template text, Pearson coefficient, direction
(positive or negative), and occurrence count. Positive means patterns spike together;
negative means one rises as the other falls.

**Use when:** Finding systemic issues -- e.g. "errors in service A always spike with
errors in service B" -- even across unrelated requests. Unlike `related_patterns`,
this uses statistical time-series correlation, not trace-level co-occurrence.

---

## 6. Alerts & Rules

### `list_rules`

Show all alert rules configured for the tenant.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | | | |

**Returns:** For each rule: name, enabled/disabled status, type (threshold or
template_watch), rule ID, condition details, and channel assignment (webhook count
or "tenant default").

**Use when:** Reviewing what alerting is configured before creating new rules.

---

### `create_rule`

Create an alert rule. This is a **write operation**.

`rule_type` is **required** and selects which other parameters apply:

- `"threshold"` — alert when a service metric crosses a value.
- `"template_watch"` — alert whenever a specific log pattern appears.

| Parameter | Type | Applies to | Description |
|-----------|------|------------|-------------|
| `name` | string | both | **Required.** Human-readable rule name |
| `rule_type` | `"threshold"` or `"template_watch"` | both | **Required.** Selects the rule variant |
| `channels` | string[] (optional) | both | Webhook URLs or PagerDuty routing keys (`pagerduty://<key>`). Empty = tenant default |
| `metric` | `"error_count"`, `"warn_count"`, or `"log_count"` | threshold | **Required for threshold.** Metric to monitor |
| `service` | string | threshold | **Required for threshold.** Service name to monitor |
| `operator` | `">"`, `">="`, `"<"`, or `"<="` | threshold | **Required for threshold.** Comparison operator |
| `value` | number | threshold | **Required for threshold.** Threshold value |
| `window_minutes` | number | threshold | **Required for threshold.** Evaluation window in minutes (1-60) |
| `template_id` | string | template_watch | **Required for template_watch.** Template ID to watch (get it from `error_patterns` or `search_templates`) |
| `template_text` | string | template_watch | **Required for template_watch.** Template text for display — copy from the pattern listing |

Omitting `rule_type`, or omitting a variant's required fields, returns a `400`.

**Threshold example** (alert if `payments-api` exceeds 10 errors in a 5-minute window):

```json
{
  "name": "payments error spike",
  "rule_type": "threshold",
  "metric": "error_count",
  "service": "payments-api",
  "operator": ">",
  "value": 10,
  "window_minutes": 5
}
```

**Template-watch example** (alert whenever a known pattern reappears):

```json
{
  "name": "watch OOM kills",
  "rule_type": "template_watch",
  "template_id": "0192f8a1-6c3e-7b21-9a4d-1f2e3d4c5b6a",
  "template_text": "Container <*> killed: out of memory"
}
```

**Returns:** Confirmation with rule name, rule ID, type, condition/pattern summary,
enabled status, and channel assignment.

**Use when:** Setting up monitoring thresholds, or watching for a specific known pattern.

> Ask your AI: "Create a rule to alert if payments-api has more than 10 errors in 5 minutes"

---

### `list_alerts`

Query recent alert firing history.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | number (optional) | 24 | Time window in hours (max 720) |
| `rule_id` | string (optional) | all | Filter to a specific rule ID |
| `service` | string (optional) | all | Filter to alerts from a specific service |
| `limit` | number (optional) | 100 | Max results (max 500) |

**Returns:** For each fired alert: rule name, timestamp, type, service, metric value
vs threshold, and number of channels notified.

**Use when:** Investigating alert activity -- what rules fired, when, and what
triggered them.

---

## 7. Raw Logs & Tags

### `raw_logs`

Fetch actual raw log lines from the customer's S3 storage.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `template_id` | string | *(required)* | Template ID to match against raw logs |
| `service` | string | *(required)* | Service name (required to locate the correct S3 path) |
| `hours` | number (optional) | 1 | Time window in hours (max 24) |
| `limit` | number (optional) | 20 | Max lines to return (max 100) |

**Returns:** Raw log line samples with timestamps, messages, and source file references.
Includes scan metadata (files scanned, bytes scanned) and truncation warnings if the
scan hit limits.

**Use when:** You need to see real log content with actual IPs, user IDs, and error
messages during an investigation.
Requires a configured S3 connector. The tool will tell you if none is configured.

---

### `live_tail`

Poll the live event buffer for real-time events.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service` | string (optional) | all | Filter to a specific service |
| `level` | string (optional) | all | Filter to exact log level (e.g. ERROR) |
| `min_level` | string (optional) | all | Minimum severity threshold (e.g. WARN shows WARN+ERROR+FATAL) |
| `template_id` | string (optional) | all | Filter to a specific template pattern |
| `min_anomaly` | number (optional) | 0 | Minimum anomaly score (0 = normal, ≥1.0 = anomalous, no upper bound) |
| `seconds` | number (optional) | 30 | How far back on first call (max 60) |
| `limit` | number (optional) | 50 | Max events to return (max 200) |
| `cursor` | number (optional) | -- | Sequence number from previous call (avoids duplicates) |

**Returns:** List of events with timestamp, service, level, status code, duration,
anomaly score, template text, and pre-processed message. Includes a cursor value
to pass on your next call for incremental polling. Warns if events were missed due
to buffer wrap.

**Use when:** During incident investigation, watching patterns emerge in real-time.
Requires tail to be enabled for the tenant.

---

### `search_by_tag`

Find events by a custom metadata tag.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | string | *(required)* | Tag key (e.g. "customer_id", "order_id") |
| `value` | string | *(required)* | Tag value to match (e.g. "ACME-123") |
| `hours` | number (optional) | 24 | Time window in hours |
| `limit` | number (optional) | 50 | Max results (max 200) |

**Returns:** Events matching the tag with timestamp, service, level, and template ID.

**Use when:** Investigating a specific customer, order, or request by their business
identifier. Only works if the tenant has configured tag extraction in Settings.

> Ask your AI: "Find all events for customer ACME-123"

---

## 8. Admin / Pipeline

### `clustering_health`

*(Listed in section 1, repeated here for discoverability.)*

Check the clustering pipeline health -- ClickHouse connectivity, circuit breaker state,
and ingest metrics. See [clustering_health](#clustering_health) above.

---

## Dev-Only Tools

These tools are only registered when `LOGWEAVE_DEV=true`. They are intended for local
development and debugging, not production use.

### `dev_health`

Check if all three LogWeave services are running (API, ClickHouse, Clusterer).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | | | |

**Returns:** UP/DOWN/ERROR status for each service with HTTP status codes or error
messages.

---

### `dev_query`

Run a read-only SQL query against ClickHouse.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sql` | string | *(required)* | SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN, or WITH only) |

**Returns:** Query results formatted as a markdown table (max 50 rows). Rejects
multi-statement queries and non-SELECT operations.

---

### `dev_data_summary`

Show row counts, time ranges, tenant counts, and log level distribution across all
LogWeave tables (log_metadata, template_stats, service_stats, template_registry,
deploys).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| *(none)* | | | |

**Returns:** Markdown table with per-table statistics and a log level breakdown.

---

## Typical Investigation Workflows

**"Something is broken, where do I start?"**
1. `overview` -- get the lay of the land
2. `list_services` -- find which service has the highest error rate
3. `diagnose_service` -- get a full diagnostic for the worst offender
4. `error_patterns` -- see the specific error templates
5. `template_events` -- get trace IDs from error instances
6. `trace_details` -- follow a request across services

**"We just deployed, did anything break?"**
1. `deploys` -- find the deploy ID
2. `changes` with `deploy_id` -- see what changed since the deploy
3. `service_outlier` -- check if the deployed service is now an outlier
4. `live_tail` with service filter -- watch real-time events

**"Is this error getting worse?"**
1. `search_templates` -- find the pattern by text
2. `template_trend` -- check the long-term daily trend
3. `correlations` -- find what else spikes at the same time
4. `related_patterns` -- find what happens in the same request flow

**"Set up monitoring for a known issue"**
1. `list_rules` -- see what rules exist
2. `create_rule` -- create a threshold alert
3. `list_alerts` -- verify it fires when expected
