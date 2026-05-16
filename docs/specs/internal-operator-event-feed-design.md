# Internal Operator Event Feed — Design Spec

**Date:** 2026-05-16
**Status:** Implemented (amended)
**Issue:** #202

## Goal

Give the solo operator a structured, queryable event feed for debugging LogWeave itself — turning "what is the system doing and why" from a multi-terminal `docker logs` scroll into a searchable, correlated, redaction-safe record.

## Approach

A small shared event-emitter module in each service (Node API, Python clusterer) writes every internal event to two sinks:

1. **stdout** — single-line structured JSON. Source of truth. Always works.
2. **ClickHouse** — best-effort ship to a dedicated `internal_events` table. Nice UI, search, correlation. Failures are silent because stdout already covered it.

Strict redaction rules gate every emission. The redaction module is the only sanctioned path to the sinks; direct `console.*` for internal events is disallowed.

## Scope

**In scope:**
- Shared event shape across services
- Dedicated `internal_events` ClickHouse table with 7-day TTL
- Reserved `_internal` tenant identifier, blocked from external API key creation
- Emitter modules: Node (API) and Python (clusterer)
- MVP event catalog (~15 events) covering lifecycle/config, downstream failures, auth/tenant anomalies
- Redaction rules enforced at the emitter
- Unit + integration test surface

**Out of scope / deferred:**
- Dashboard UI changes — events are queryable via existing endpoints under the `_internal` tenant
- External uptime check (different problem)
- Slack alerts on internal events (defer until we know which events actually fire)
- Performance signals (slow queries, queue depth, cache misses)
- Dogfooding hooks (different goal — see `feedback_*` memories)
- Retry, in-memory buffer, or disk spool for failed CH ships — stdout is enough

## Design

### Event shape

Identical across services:

```json
{
  "ts": "2026-05-16T14:23:01.482Z",
  "service": "api" | "clusterer",
  "event": "clickhouse.query_failed",
  "severity": "info" | "warn" | "error",
  "code": "CH_QUERY_TIMEOUT",
  "summary": "ClickHouse query exceeded 5s timeout",
  "fields": { "query_kind": "template_lookup", "duration_ms": 5012 }
}
```

- `event` — stable dotted name, never free-form
- `code` — short stable identifier for grouping/alerts
- `summary` — short human string, must never include user/customer/secret data
- `fields` — small dict of safe metadata only

### Dedicated ClickHouse table

A new table, separate from the customer logs path:

```sql
CREATE TABLE internal_events (
  ts          DateTime64(3, 'UTC'),
  service     LowCardinality(String),
  event       LowCardinality(String),
  severity    LowCardinality(String),
  code        LowCardinality(String),
  summary     String,
  fields      String  -- JSON
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (service, event, ts)
TTL ts + INTERVAL 7 DAY DELETE;
```

Rationale for a dedicated table (per the user's call):
- Clean schema separation from customer logs
- Simpler TTL — applied at table level, no tenant-aware partition trickery
- No risk of internal traffic polluting customer query paths or template clustering
- Internal feed never goes through Drain3

### Reserved `_internal` tenant

`_internal` is reserved as a tenant identifier. Because LogWeave has no API-key
creation endpoint today (keys come from the `LOGWEAVE_API_KEYS` env var),
reservation is enforced at config-load: any key mapped to `_internal` causes
zod validation to fail with a clear error.

For the `internal_events` table itself, tenant scoping is irrelevant; the operator
queries by `service` + `event`.

### Emission path

- One small module per service: `internalEvents.ts` (API), `internal_events.py` (clusterer)
- Each module exposes a single `emit(event, severity, code, summary, fields)` function
- Function:
  1. Runs redaction over `summary` and `fields`
  2. Writes a single JSON line to stdout
  3. Fires a non-blocking, best-effort write to ClickHouse
  4. Catches and swallows any CH error (stdout already has it)

No retry, no in-memory buffer, no disk spool. Per the user's "not overthinking it" cue.

### Per-request event coalescing

`auth.key_invalid` and `ratelimit.exceeded` are per-request events. Under an
auth-attack or runaway client they could flood `internal_events`. The emitter
coalesces them to at most one emission per `(event, tenant_id, code)` per
10 seconds. The clusterer side has no equivalent because it never emits per-request
events.

### Redaction rules (non-negotiable)

Enforced inside the emitter. There is no way to bypass.

**Config events** (`config.loaded`, `config.invalid`):
- Allowlist of field names whose values may appear verbatim: `port`, `log_level`, `clickhouse_host`, `clusterer_url`, `node_env`, `service_version`
- Every other config key is logged as `{ key: "<redacted:len=N>" }`

**Error events** (`*.failed`, `*.invalid`, `*.unreachable`):
- Allowed: error class name, error code, `file:line`, sanitized message
- Forbidden in CH payload: full stack traces, request bodies, query text, customer log content, webhook URLs, API keys, query parameters with values
- Stack traces may appear on stdout only (operator-only via `docker logs`)

**Tenant/auth events** (`auth.*`, `ratelimit.*`, `quota.*`):
- Allowed: `tenant_id`, API key prefix (first 6 chars, e.g. `lw_abc1`), route, status code
- Forbidden: full API keys, request bodies, response bodies

**Universal forbidden list** (across all events):
- API keys, bearer tokens, webhook URLs, raw log content, request/response bodies, query parameter values, environment variable values outside the allowlist

### MVP event catalog (~15 events)

**Lifecycle + config:**
- `service.started` — info; fields: `service_version`, `node_env`
- `service.stopping` — info; fields: `reason`
- `config.loaded` — info; fields: redacted summary
- `config.invalid` — error; fields: which keys failed validation (names only)
- `migration.applied` — info; fields: `migration_id`

**Downstream failures:**
- `clickhouse.query_failed` — error; fields: `query_kind`, `code`, `duration_ms`
- `clickhouse.unreachable` — error; fields: `host`
- `clusterer.timeout` — warn; fields: `duration_ms`
- `clusterer.unreachable` — error; fields: `url_host`
- `slack.webhook_failed` — warn; fields: `status_code`
- `s3.connector_failed` — error; fields: `connector_id`, `code`

**Tenant + auth anomalies:**
- `auth.key_invalid` — warn; fields: `key_prefix`, `route`, `tenant_id` (set to `_unknown` since the key didn't resolve)
- `ratelimit.exceeded` — warn; fields: `tenant_id`, `route`, `limit_kind`, `source`, `retry_after_seconds`

**Dropped from MVP during implementation:**
- `auth.tenant_unknown` — the current `KeyStore.validate()` cannot distinguish a malformed key from a key resolving to an unknown tenant; both fall through to `auth.key_invalid`. Re-introduce if/when a separate tenant directory exists.
- `quota.exceeded` — no quota enforcement code exists. Add the event when the feature lands.

Every event in this list must be added with both an emission site and a test.

### What we will NOT do

- No new endpoint, no new UI, no new dashboard page
- No SDK changes to `@logweave/transport`
- No external uptime probe
- No structured logging library swap (no pino/winston migration as part of this)
- No retry/buffer/spool

## Open Questions

None at spec time.

## Test Strategy

**Unit (per service):**
- Redaction: every disallowed config key produces `<redacted:len=N>`; allowlisted keys pass through
- Redaction: stack traces stripped from CH payload, retained for stdout
- Emitter: stdout receives a parseable JSON line even when the CH transport throws
- Emitter: `event` name not in catalog → throws in dev, no-ops in prod (catch typos early without crashing in prod)

**Integration (against real ClickHouse via docker-compose):**
- Insert 5 events covering all 3 categories; query via existing endpoints; confirm shape
- Insert an event with `ts = now - 8 days`; confirm pruned by TTL (`OPTIMIZE TABLE internal_events FINAL` to force)
- Attempt API key creation for `tenant_id = "_internal"`; confirm 4xx

**Negative coverage:**
- Synthetic event carrying a fake API key in `fields` → assert scrubbed before CH and stdout
- Synthetic config object containing `CLICKHOUSE_PASSWORD` → assert value never appears in any sink
