# Alarm System v2 — Threshold Rules, Alert History, Dashboard Tab

**Date:** 2026-03-22
**Status:** Approved
**Issues:** New (to be created from this spec)

## Goal

Extend the alarm system from template-only anomaly watches to a full alerting platform
with threshold-based rules, persistent alert history, per-rule channel assignment,
and a dashboard alerts tab for central management.

## Approach

- **Two evaluator types** sharing one dispatcher: `AlertEvaluator` (existing template anomalies)
  and `ThresholdEvaluator` (new service-level threshold rules)
- **Query ClickHouse for threshold rules** (Approach A per architect review) — no in-memory scorer
  extension. New rule types = new SQL templates, not code changes.
- **New 5-minute service_stats MV** — required for sub-hour threshold windows
- **Alert history table** in ClickHouse (append-only, 90-day TTL)
- **Per-rule notification channels** — each rule can target a specific webhook/channel
- **Dashboard alerts tab** — view all rules, attach/detach channels, enable/disable. Rules
  created in context (template detail panel, service health cards), managed centrally.

## Scope

**In scope:**
- 5-minute service_stats MV (`service_stats_5m`, 7-day TTL)
- Threshold rule data model: metric, service, operator, value, window, channels
- RuleStore (ClickHouse + in-memory cache, like WatchStore)
- ThresholdEvaluator (60s loop, batched ClickHouse queries, cooldown)
- Alert history table + HistoryObserver (logs every fired alert)
- Alert history API: `GET /v1/alerts?hours=24`
- MCP tools: `list_alerts`, `list_rules`, `create_rule`
- Dashboard alerts tab: list rules, toggle enable/disable, attach channels
- Per-rule channel assignment with tenant default fallback
- Rules created in context: "Watch this pattern" button (exists), "Alert on this service" (new)

**Out of scope / deferred:**
- PagerDuty / OpsGenie integration (#106 — separate issue, needs channels working first)
- Acknowledge/resolve workflow (needs PagerDuty to be meaningful)
- Alert grouping/deduplication across rules
- Custom evaluation intervals per rule
- Email notification channel
- Per-user alert subscriptions (vs per-tenant/per-rule)

## Design

### 1. New 5-Minute Service Stats MV

```sql
CREATE TABLE IF NOT EXISTS logweave.service_stats_5m (
    tenant_id          LowCardinality(String),
    service            LowCardinality(String),
    level              LowCardinality(String),
    interval_start     DateTime64(3),
    log_count          AggregateFunction(count),
    error_count        AggregateFunction(countIf, UInt8),
    warn_count         AggregateFunction(countIf, UInt8)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(interval_start)
ORDER BY (tenant_id, service, interval_start)
TTL toDateTime(interval_start) + toIntervalDay(7) DELETE
SETTINGS ttl_only_drop_parts = 1

CREATE MATERIALIZED VIEW IF NOT EXISTS logweave.service_stats_5m_mv
TO logweave.service_stats_5m AS
SELECT
    tenant_id, service, level,
    toStartOfFiveMinutes(timestamp) AS interval_start,
    countState()                    AS log_count,
    countIfState(level = 'ERROR')   AS error_count,
    countIfState(level = 'WARN')    AS warn_count
FROM logweave.log_metadata
GROUP BY tenant_id, service, level, interval_start
```

7-day TTL (alerting only, not dashboards). Existing hourly MV stays for trend queries.

### 2. Threshold Rule Data Model

```sql
CREATE TABLE IF NOT EXISTS logweave.alert_rules (
    tenant_id      LowCardinality(String),
    rule_id        String,
    name           String,
    rule_type      LowCardinality(String),  -- 'template_watch' | 'threshold'
    enabled        UInt8 DEFAULT 1,
    config         String,                   -- JSON: metric, service, operator, value, window
    channels       String DEFAULT '[]',      -- JSON array of webhook URLs
    version        UInt64,
    is_deleted     UInt8 DEFAULT 0
) ENGINE = ReplacingMergeTree(version, is_deleted)
ORDER BY (tenant_id, rule_id)
```

Config JSON for threshold rules:
```json
{
  "metric": "error_count",
  "service": "payments",
  "operator": ">",
  "value": 10,
  "windowMinutes": 5,
  "level": "ERROR",
  "statusCode": 500
}
```

Config JSON for template watches (migrated from current watches table):
```json
{
  "templateId": "019cfb43-...",
  "templateText": "Connection to <*> timed out"
}
```

### 3. Alert History Table

```sql
CREATE TABLE IF NOT EXISTS logweave.alert_history (
    alert_id       String,
    tenant_id      LowCardinality(String),
    rule_id        String,
    rule_type      LowCardinality(String),
    rule_name      String,
    fired_at       DateTime64(3) DEFAULT now64(3),
    metric_value   Float64,
    threshold_value Float64,
    details        String DEFAULT '',
    channels_notified String DEFAULT '[]'
) ENGINE = MergeTree()
ORDER BY (tenant_id, fired_at)
TTL toDateTime(fired_at) + toIntervalDay(90) DELETE
SETTINGS ttl_only_drop_parts = 1
```

### 4. ThresholdEvaluator

Sibling to `AlertEvaluator`, shares same `AlertDispatcher` and cooldown mechanics.

```
60s loop:
  1. Load active threshold rules from RuleStore
  2. Group rules by (tenantId, metric, windowMinutes)
  3. For each group, run ONE batched ClickHouse query against service_stats_5m
  4. Compare results against rule thresholds
  5. Apply cooldown (30-min per rule)
  6. Dispatch alerts through AlertDispatcher
  7. INSERT into alert_history via HistoryObserver
```

### 5. API Surface

**Rules CRUD:**
- `POST /v1/rules` — create a rule (threshold or template watch)
- `GET /v1/rules` — list all rules for tenant
- `PUT /v1/rules/:id` — update rule (enable/disable, change channels, modify threshold)
- `DELETE /v1/rules/:id` — delete rule

**Alert History:**
- `GET /v1/alerts?hours=24&rule_id=...&service=...` — query alert history

**Migration:** Existing watches remain functional. New rules API is additive. Eventually
migrate watches to rules table, but not blocking.

### 6. MCP Tools

- `list_rules` — show all active alert rules with their configs
- `create_rule` — create a threshold rule (e.g., "alert if payments has >10 500 errors in 5min")
- `list_alerts` — query alert history (what fired recently?)

### 7. Dashboard Alerts Tab

New sidebar item: "Alerts" (between Dashboard and Live Tail)

**Layout:**
- Top: active rules list (name, type badge, service, threshold, status on/off toggle, channels)
- Bottom: alert history timeline (most recent first, filterable by rule/service)
- No rule creation on this page — rules created in context:
  - Template detail panel: "Watch this pattern" (existing button, creates template_watch rule)
  - Service health card: "Alert on this service" (new, creates threshold rule)

### 8. Per-Rule Channels

Each rule has a `channels` JSON array of webhook URLs. When the evaluator fires an alert:
1. If rule has channels → send to those specific webhooks
2. If rule has no channels → fall back to tenant's default Slack webhook
3. Channels can be added/removed from the dashboard alerts tab

## Migration Path

1. Build new tables + ThresholdEvaluator alongside existing system
2. Existing WatchStore + AlertEvaluator continue working unchanged
3. Dashboard "Watch this pattern" button creates a rule in the new table
4. Eventually deprecate old watches table and migrate to rules table
5. AlertEvaluator can be refactored to read from rules table instead of watches table

## Test Strategy

- ThresholdEvaluator: mock DB, verify batched queries, threshold comparison, cooldown
- RuleStore: CRUD with mock DB (same pattern as WatchStore tests)
- HistoryObserver: verify INSERT on alert dispatch
- API: route tests for rules CRUD and alert history query
- Integration: create rule → ingest events exceeding threshold → verify alert fires + history logged

## Open Questions

None — architect review resolved the evaluation approach.
