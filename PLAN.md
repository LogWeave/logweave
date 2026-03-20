# Log Intelligence Platform — V8 Architecture Plan

> **Core thesis:** We are not a logging platform. We never store your logs. We read them,
> extract patterns, and discard the raw content. What we keep: which error patterns exist,
> how often they fire, which ones are anomalous, and where to find the originals. Your raw
> logs go to S3 — not CloudWatch — cutting storage costs 50–80%. You query the intelligence
> in plain English. We alert you with context, not just thresholds. Available as SaaS or
> self-hosted Docker on any cloud.

*V8 — March 2026. Updated from V7 based on seventh-round adversarial review. Solo maintainer.
Supersedes all previous versions.*

---

## What Changed from V7

- **Unclustered row recovery** — the in-memory re-cluster queue had an unrecoverable data
  loss bug: if the API restarts during a clusterer outage, the pre-processed message text
  is lost and those rows stay as `template_id=0` permanently. Fixed by adding a nullable
  `pre_processed_message` column to `log_metadata`, populated only for unclustered rows.
  On startup, a reconciliation query re-clusters any recent `template_id=0` rows.
- **template_registry reads use FINAL** — ReplacingMergeTree deduplicates asynchronously.
  Reads before merge can return duplicate rows with different IDs. All registry lookups
  now use `SELECT ... FINAL` to guarantee consistent results.
- **Week 1 split into 1a and 1b** — the original Week 1 scope was 8–10 days of work
  for one developer, not 5. Split into Week 1a (clusterer standalone) and Week 1b (API
  server + transport). Total MVP is now honestly 5 weeks, not 4.
- **Graduated anomaly threshold** — the 1-hour cold-start silence is too long. Replaced
  with graduated sensitivity: 10x threshold for first 60 minutes, 3x thereafter. Catches
  catastrophic failures during onboarding (proving value when it matters most) without
  firing on baseline noise.
- **Two-language operational burden acknowledged** — the Python (clusterer) + Node.js
  (API) split is the right engineering decision but carries real ongoing overhead for a
  solo maintainer. Explicitly documented in architecture section with mitigation rationale.
- **Low-volume Model C messaging split** — customers saving <$100/month get informational
  messaging ("here's what it would save") not a conversion CTA. Their expansion path is
  more services, not Model C migration.
- **Pre-build experiment timeboxed at 1 day** — 4 hours was optimistic for someone new
  to Drain3. Realistically 6–8 hours once log extraction, parameter tuning, and output
  evaluation are honestly counted. Timebox: one full day. If Drain3 doesn't produce useful
  templates in a day, that's the signal.
- **Distribution rewritten as a first-class section** — the biggest gap in all previous
  versions. 10 contacts will not reliably produce 5 paying customers. The realistic funnel
  requires 20–30 initial contacts, explicit contingencies for when the first list is
  exhausted, and a clear outreach sequence. Distribution gets the same rigour as architecture.

---

## Table of Contents

1. [What We Are (And What We Are Not)](#1-what-we-are-and-what-we-are-not)
2. [Target Customer](#2-target-customer)
3. [Competitive Landscape](#3-competitive-landscape)
4. [The Two-Step Go-to-Market](#4-the-two-step-go-to-market)
5. [Ingestion Models](#5-ingestion-models)
6. [Architecture](#6-architecture)
7. [Data Model](#7-data-model)
8. [Log Source Adapters](#8-log-source-adapters)
9. [Metadata Extraction](#9-metadata-extraction)
10. [LLM Layer](#10-llm-layer)
11. [Features & UX](#11-features--ux)
12. [Onboarding](#12-onboarding)
13. [Pricing & Unit Economics](#13-pricing--unit-economics)
14. [Distribution](#14-distribution)
15. [Build Roadmap](#15-build-roadmap)
16. [Self-Hosted Deployment](#16-self-hosted-deployment)
17. [Multi-Cloud Extension](#17-multi-cloud-extension)
18. [Scaling Path](#18-scaling-path)
19. [Validation Assumptions](#19-validation-assumptions)
20. [What Not to Build Yet](#20-what-not-to-build-yet)
21. [Technology Stack](#21-technology-stack)

---

## 1. What We Are (And What We Are Not)

**We are a log intelligence platform.** We read log streams, extract patterns, detect
anomalies, and surface structured intelligence — queryable by your AI assistant via MCP
or REST API.

**We are not a log store.** We never hold raw log content. Not temporarily, not in
samples, not in a cache. Raw logs belong to the customer. They stay in the customer's
infrastructure (S3, CloudWatch, Azure Blob, wherever). We store only derived intelligence:
patterns, counts, anomaly scores, field statistics, and pointers back to where the
originals live.

**We replace CloudWatch Logs as a query and alerting tool.** We do not replace it as a
storage system. Instead, we redirect raw logs to S3 (50–80% cheaper than CloudWatch Logs)
and provide dramatically better querying, alerting, and investigation on top.

**We never penalise customers for optimising.** Our pricing is per-service, not per-GB.
When we help a customer reduce log noise, their bill stays the same — and their
infrastructure costs go down. Volume reduction recommendations are a feature, not a
threat to our revenue.

### What we store vs what we don't

```
What we store (metadata — derived intelligence):
  - Drain3 log template patterns ("Connection timeout to {host}:{port} after {duration}ms")
  - Template occurrence counts per time interval
  - Anomaly scores per template per interval
  - Extracted field statistics (avg duration_ms, status_code distribution, error rates)
  - Source pointers (CloudWatch log group + stream, or S3 URI + byte range)
  - Service names, log levels, timestamps

What we never store:
  - Raw log lines
  - User IDs, emails, IP addresses, request/response bodies
  - Any content that could be subpoenaed as "customer data"
  - Anything on the never_extract list
```

### The sentence a compliance officer can approve

> "This system stores statistical patterns derived from your logs — template shapes,
> occurrence counts, and anomaly scores. It never stores raw log content. Raw logs remain
> in your own infrastructure. The system can fetch individual log lines on demand from
> your log source for investigation, but nothing is persisted."

---

## 2. Target Customer

**Primary:** Engineering teams at seed–Series C startups, 5–100 engineers. AWS-native.
Experiencing one or both of:
- **CloudWatch bill shock** — paying $500+/month for CloudWatch Logs and not getting
  proportional value
- **CloudWatch query frustration** — spending 20+ minutes per incident fighting CloudWatch
  Insights when they should be fixing the problem

No dedicated SRE team. Buyer is a backend engineer or engineering manager who pays the
AWS bill and investigates production incidents.

**Secondary (Year 1):** Same profile on Azure. Azure Monitor Logs costs $2.76/GB ingestion
(5.5x CloudWatch). The pain is more acute. The multi-cloud architecture supports this
without a separate product.

**Self-hosted:** Companies with data sovereignty requirements, or large AWS EDP committed
spend who want to use existing credits. Same product, runs in their infrastructure, billed
via Stripe (Marketplace listing later).

**Not Year 1:** Fortune 500 procurement cycles. On-premise only. Companies without a
cloud log source we can read from.

---

## 3. Competitive Landscape

### The real competitors are AWS's own tools

**Amazon CloudWatch Anomaly Detection**
AWS ships anomaly detection natively inside CloudWatch. It's metric-based, not
log-pattern-based. It fires on numeric thresholds (error rate, latency counts) but has
no concept of log templates — it cannot tell you that a *new error pattern appeared 3
minutes after your last deployment*, or that "Connection timeout to db-prod" and
"Connection timeout to db-replica" are the same structural error in different contexts.
Our anomaly detection is pattern-aware and deployment-correlated. Theirs is metric-aware
and threshold-based.

**Amazon Q Developer**
Amazon Q has direct access to CloudWatch Logs, CloudTrail, Health events, and AWS resource
relationships. It can explain errors from a customer's environment without manual context
input. It is free for AWS customers.

Where Q falls short for log investigation specifically:
- No concept of log *templates* — it sees individual log lines, not pattern clusters
- No *occurrence history* — it can't tell you "this pattern has fired 847 times in the
  last 20 minutes, up from a baseline of 30"
- No *template evolution* — it can't show which patterns appeared or disappeared after
  a deployment
- No *proactive Slack alerts* — it answers questions when asked; we push context when
  something changes
- No incentive to offer the cost savings story. AWS earns from CloudWatch ingestion fees.
  We earn from helping customers reduce them.

Our edge is depth on log patterns and proactive delivery. These are complementary tools
for many customers.

**Loki + Grafana (self-hosted)**
Raw log search, not pattern intelligence. Honest cost when infrastructure is counted:
$100–140/month for a production-grade setup. No anomaly detection, no pattern grouping,
no plain-English querying out of the box. Requires engineering time to operate. Engineers
who want full-text log search should use Loki. We compete for the engineer who wants to
*understand* their logs, not search them.

**Datadog Logs / New Relic**
Enterprise pricing, full-platform lock-in, complex onboarding. Not Year 1 competition.

### Our positioning

We don't replace CloudWatch — we complement it in Model B and replace it in Model C.
We don't replace Amazon Q — we go deeper on log patterns where Q is shallow. The
comparison that matters: CloudWatch Insights as it is today, versus pattern-aware anomaly
detection and plain-English querying at $79/month with a path to 80% cost savings.

---

## 4. The Two-Step Go-to-Market

Landing with "save money" requires the customer to change their log pipeline before they
trust us. Landing with "add intelligence" requires only adding a logger transport. Trust
first, migrate second.

### Step 1 — Land (Week 1–2 of customer journey)

> "Add our winston transport alongside your existing CloudWatch logging. One line of config.
> See your logs organised into patterns, get anomaly alerts with context, ask questions in
> plain English. You're paying us + CloudWatch for now. That's okay."

- Customer adds transport (one line)
- Logs go to CloudWatch AND to us simultaneously
- We extract metadata, detect patterns, surface anomalies
- Dashboard, alerts, and MCP/API intelligence available immediately
- CloudWatch bill unchanged; our subscription is $79/month on top
- **This is a capability sale, not a cost sale**

### Step 2 — Expand (Triggered by savings threshold)

When estimated CloudWatch savings from Model C exceed **$100/month** for monitored
services, the dashboard surfaces the comparison automatically:

> "Your monitored services send 100GB/day to CloudWatch — roughly **$1,500/month**.
> Switch to Model C and those logs go to your S3 instead: **$84/month**. One
> CloudFormation stack. Ready to set it up?"

For low-volume customers (estimated savings <$100/month), surfacing a conversion CTA is
not the right move — the friction-to-reward ratio is wrong and the customer will rationally
decline. Instead, at the 60-day mark, show informational context:

> "Your services send ~2GB/day to CloudWatch (~$29/month). Model C would route those to S3
> instead for ~$29/month less. At your current volume, most customers stay on Model B —
> the intelligence features are the primary value. When your volume grows, we'll surface
> the savings comparison automatically."

**Low-volume expansion path is more services, not Model C.** A customer on 3 services
paying $79/month who adds services 4–5 moves to Growth at $249/month. That is the
expansion revenue for this segment.

### Step 3 — Deepen (Month 4+)

- Add more services (natural upsell to higher tier)
- Enable deployment correlation (GitHub/GitLab webhook)
- Volume reduction recommendations
- Become the tool the on-call engineer opens first, every time

---

## 5. Ingestion Models

Three models. Model A (we store raw logs) is eliminated.

### Model B — Alongside (Landing / Default)

```
Customer application
    ├── existing logger → CloudWatch (unchanged)
    └── our transport  → our API → extract metadata → discard raw
```

- **Customer needs:** API key only
- **Friction:** one line of logger config
- **We hold:** metadata only
- **Best for:** onboarding. Zero risk. Customer keeps CloudWatch as safety net.

### Model C — Redirect to S3 (Expansion)

```
Customer application
    └── our transport → our API → extract metadata
                               → write raw to customer's S3 bucket
                      (CloudWatch disabled for these log groups)
```

- **Customer needs:** API key + S3 bucket + IAM role (CloudFormation one-click)
- **Friction:** low — one CloudFormation stack, one SDK config change
- **We hold:** metadata only
- **Cost impact:** eliminates CloudWatch ingestion ($0.50/GB), reduces storage
  (S3 $0.023/GB vs CloudWatch $0.03/GB)

### Model D — Customer Pre-Extracts

```
Customer's own pipeline → pushes metadata + source pointer → our API
```

- **Best for:** sophisticated teams with existing log pipelines

### Default path

Every customer starts on Model B. The product surfaces Model C when savings cross
$100/month, or informational context at 60 days for low-volume customers.

---

## 6. Architecture

### Design Principle: One Stack, Two Modes

Same Docker images, same code, environment variables differentiate SaaS (multi-tenant)
from self-hosted (single-tenant).

### Stack (MVP) — Three Containers

```
Docker Compose (3 containers)
  ├── logweave-api          (Node.js / Express)
  │     ├── POST /v1/ingest/batch
  │     ├── POST /v1/deploys
  │     ├── GET  /v1/deploys
  │     ├── GET  /v1/overview                    (composite)
  │     ├── GET  /v1/templates/:id/detail        (composite)
  │     ├── GET  /v1/services/:name/health       (composite)
  │     ├── GET  /v1/templates/search
  │     ├── GET  /v1/dashboard/*                 (existing dashboard endpoints)
  │     └── GET  /                               (dashboard SPA)
  │
  ├── logweave-clusterer    (Python / FastAPI)
  │     └── POST /cluster
  │
  └── clickhouse
        ├── log_metadata
        ├── template_stats     (materialised view)
        ├── service_stats      (materialised view)
        ├── template_registry
        └── deploys

Standalone (runs on developer's machine, not in Docker Compose)
  └── @logweave/mcp         (Node.js, MCP server via stdio)
        └── 7 tools: overview, error_patterns, changes, template_detail,
            service_health, search_templates, deploys
```

### Two-Language Operational Overhead — Acknowledged

The stack uses Node.js (API server) and Python (clusterer). This is the correct
engineering decision — Drain3 is Python-only with no production-equivalent in the Node.js
ecosystem, and porting it would cost weeks with zero customer benefit. But it carries real
ongoing overhead for a solo maintainer:

- Two dependency update cycles (npm audit + pip audit, separate schedules)
- Two Docker builds and base image CVE chains to track
- Two debug workflows when the pipeline fails (Express logs + FastAPI logs, different
  stack trace formats)
- Cognitive context-switching cost between JavaScript and Python mid-debugging

**Mitigation:** The clusterer is a stable, single-purpose service with a one-endpoint API
contract. Once built and tested in Week 1a, it changes infrequently — Drain3 parameters,
checkpoint interval, pre-processing patterns. The maintenance burden is front-loaded and
amortises over time. If the clusterer's share of engineering time exceeds 20% in any
given month after launch, evaluate consolidation.

### Clusterer Degradation Contract

The clusterer is best-effort enrichment, not a gate:

```
Normal:
  API → POST /cluster (timeout: 500ms) → template_id + text → write to ClickHouse

Timeout or non-200:
  Write to ClickHouse:
    template_id = 0
    template_text = '[unclustered]'
    pre_processed_message = <the pre-processed text>  ← recoverable
  Add to in-memory re-cluster queue

On API server startup:
  SELECT id, pre_processed_message FROM log_metadata
  WHERE template_id = 0
  AND ingest_time > now() - INTERVAL 24 HOUR
  → send to clusterer → UPDATE template_id, template_text, NULL pre_processed_message
```

The `pre_processed_message` column is the durable fallback — it exists only for unclustered
rows and is nulled out once recovery succeeds. The in-memory queue is the fast path during
a transient outage. The startup reconciliation is the recovery path after a restart.

### Clusterer API Contract

```
POST /cluster

Request:
{
  "tenant_id": "customer_abc",
  "messages": ["pre-processed message text", ...]
}

Response 200:
{
  "results": [
    { "template_id": 1042, "template_text": "Connection timeout to {host} after {duration}ms", "is_new": false }
  ]
}

Response non-200 or timeout → API falls back to template_id=0
```

**State:** Drain3 tree in memory per tenant. Checkpointed to volume every 60 seconds
(atomic rename). Template IDs come from `template_registry` — not Drain3's internal
numbering.

### Environment Variables

```bash
LOGWEAVE_CLICKHOUSE_URL=clickhouse://clickhouse:9000/logweave
LOGWEAVE_CLUSTERER_URL=http://logweave-clusterer:8000
LOGWEAVE_CLUSTERER_TIMEOUT_MS=500
LOGWEAVE_RATE_LIMIT_RPM=60
LOGWEAVE_RATE_LIMIT_TENANT_RPM=120
LOGWEAVE_RATE_LIMIT_INGEST_RPM=300
LOGWEAVE_MAX_CONCURRENT_QUERIES=8
LOGWEAVE_LOG_SOURCE=cloudwatch|s3|azure_monitor|none
LOGWEAVE_AWS_REGION=us-east-1
LOGWEAVE_AWS_ROLE_ARN=
LOGWEAVE_RAW_DESTINATION=none|s3
LOGWEAVE_RAW_S3_BUCKET=
LOGWEAVE_RAW_S3_ROLE_ARN=
LOGWEAVE_MODE=saas|selfhosted
LOGWEAVE_LICENSE_KEY=
LOGWEAVE_DEFAULT_TENANT=default
```

---

## 7. Data Model

### ClickHouse Schema

```sql
CREATE TABLE log_metadata (
    tenant_id              LowCardinality(String),
    timestamp              DateTime64(3),
    ingest_time            DateTime64(3) DEFAULT now64(3),

    service                LowCardinality(String),
    level                  LowCardinality(String),
    environment            LowCardinality(String),

    -- 0 = unclustered (clusterer unavailable at ingest time)
    template_id            String,
    template_text          String,
    is_new_template        UInt8,

    anomaly_score          Float32,

    status_code            Nullable(UInt16),
    duration_ms            Nullable(Float64),
    trace_id               Nullable(String),
    route                  Nullable(LowCardinality(String)),

    source_type            LowCardinality(String),
    source_ref             String,

    -- Populated only when template_id = 0 (clusterer was unavailable)
    -- Nulled out after successful re-clustering on recovery
    pre_processed_message  Nullable(String)

) ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(timestamp))
ORDER BY (tenant_id, service, level, timestamp)
TTL timestamp + toIntervalDay(30) DELETE
SETTINGS index_granularity = 8192;

-- Authoritative template ID registry
CREATE TABLE template_registry (
    tenant_id           LowCardinality(String),
    template_text_hash  UInt64,        -- cityHash64(template_text)
    template_text       String,
    template_id         String,
    first_seen          DateTime64(3)
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, template_text_hash);

-- Template statistics (excludes unclustered rows)
CREATE MATERIALIZED VIEW template_stats
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(interval_start))
ORDER BY (tenant_id, service, template_id, interval_start)
AS SELECT
    tenant_id, service, template_id,
    any(template_text)                AS template_text,
    toStartOfFiveMinutes(timestamp)   AS interval_start,
    count()                           AS occurrence_count,
    countIf(level = 'ERROR')          AS error_count,
    avg(duration_ms)                  AS avg_duration_ms,
    max(anomaly_score)                AS max_anomaly_score
FROM log_metadata
WHERE template_id > 0   -- unclustered rows excluded from template aggregation
GROUP BY tenant_id, service, template_id, interval_start;

-- Service statistics (includes all rows, including unclustered)
CREATE MATERIALIZED VIEW service_stats
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(interval_start))
ORDER BY (tenant_id, service, interval_start)
AS SELECT
    tenant_id, service,
    toStartOfHour(timestamp)      AS interval_start,
    count()                       AS log_count,
    countIf(level = 'ERROR')      AS error_count,
    countIf(level = 'WARN')       AS warn_count,
    countIf(is_new_template = 1)  AS new_template_count,
    avg(anomaly_score)            AS avg_anomaly_score
FROM log_metadata
GROUP BY tenant_id, service, interval_start;
```

### Template ID Assignment

```
Clusterer receives pre-processed messages
  → Drain3 groups into structural patterns
  → For each unique pattern text:
      hash = cityHash64(template_text)
      -- Always use SELECT ... FINAL to avoid ReplacingMergeTree pre-merge duplicates
      result = SELECT template_id FROM template_registry FINAL
               WHERE tenant_id = X AND template_text_hash = hash LIMIT 1
      if found: use that template_id
      if not found:
        acquire process-level lock on hash
        re-check (another thread may have inserted while waiting)
        if still not found: insert new row with next_id, return is_new = true
        release lock
```

`SELECT ... FINAL` guarantees consistent reads from ReplacingMergeTree before background
deduplication runs. Process-level lock prevents the concurrent-insert race on new template
discovery within the same clusterer instance.

### Multi-Tenancy

Three independent enforcement layers:

1. **Query middleware** — `AND tenant_id = :current_tenant` injected before any query
2. **API key → tenant_id mapping** — server-side only, never client-controlled
3. **ClickHouse Row-Level Security** — database-level guarantee

The LLM never sees, fills, or touches `tenant_id`.

### Retention

```sql
-- Per tier: Startup 30d | Growth 90d | Scale 365d
ALTER TABLE log_metadata MODIFY TTL timestamp + toIntervalDay(30) DELETE;
```

---

## 8. Log Source Adapters

```typescript
interface LogSourceAdapter {
  fetchSamples(
    sourceRef: string,
    pattern: string,
    timeRange: { start: Date; end: Date },
    limit: number
  ): Promise<string[]>
}
```

| Adapter | Source | Timeline |
|---|---|---|
| NoneAdapter | (no read-back) | Default, MVP |
| CloudWatchAdapter | CloudWatch Logs | Week 6 (first customer) |
| S3Adapter | Customer S3 | Week 6 (first customer) |
| AzureMonitorAdapter | Azure Monitor | First Azure customer (~2d) |
| AzureBlobAdapter | Azure Blob | First Azure customer (~1d) |
| GCPLoggingAdapter | GCP Cloud Logging | Year 2 (~2d) |
| GCSAdapter | GCP Cloud Storage | Year 2 (~1d) |

NoneAdapter is sufficient for the MVP. CloudWatch and S3 adapters move to Week 6 to be
tested against real customer logs, not synthetic data.

---

## 9. Metadata Extraction

### Extraction Pipeline

```
Raw log event arrives
    │
    ├── 1. Parse (JSON, logfmt, or regex per config)
    ├── 2. Extract configured fields (JSONPath)
    ├── 3. Apply never_extract filter
    ├── 4. Pre-process message text (strip high-cardinality values)
    ├── 5. POST /cluster to clusterer (500ms timeout)
    │         → SUCCESS: stable template_id + template_text
    │         → FAIL:    template_id=0, store pre_processed_message for recovery
    ├── 6. Calculate anomaly_score (skip for template_id=0)
    ├── 7. Build source_ref pointer
    ├── 8. Write to ClickHouse
    └── 9. If Model C: PutObject to customer S3
           If Model B: discard raw
```

### Unclustered Row Recovery

```javascript
// On API server startup
async function reconcileUnclusteredRows() {
  const rows = await clickhouse.query(`
    SELECT id, tenant_id, pre_processed_message
    FROM log_metadata
    WHERE template_id = 0
      AND ingest_time > now() - INTERVAL 24 HOUR
      AND pre_processed_message IS NOT NULL
  `)
  for (const row of rows) {
    const result = await clusterMessages([row.pre_processed_message], row.tenant_id)
    await clickhouse.query(`
      ALTER TABLE log_metadata UPDATE
        template_id = ${result[0].template_id},
        template_text = '${result[0].template_text}',
        pre_processed_message = NULL
      WHERE id = '${row.id}'
    `)
  }
}
```

### Pre-Processing Patterns

Strip high-cardinality values from message text before clustering. Validated against real
logs in the pre-build experiment — thresholds below are defaults, not fixed values:

```
UUIDs:              [0-9a-f]{8}-[0-9a-f]{4}-...  → <UUID>
Large numeric IDs:  \b\d{6,}\b                   → <ID>   (preserves port 8080, HTTP 404)
Email addresses:    [a-z0-9._%+-]+@[a-z0-9.-]+   → <EMAIL>
IPv4 addresses:     \b\d{1,3}(\.\d{1,3}){3}\b    → <IP>
ISO timestamps:     \d{4}-\d{2}-\d{2}T\d{2}:...  → <TS>
Long hex strings:   \b[0-9a-f]{16,}\b             → <HEX>
```

The `\d{6,}` threshold (6+ digits) preserves short numbers (port numbers, status codes,
brief durations) as potential template differentiators while stripping order IDs, user
IDs, and other large identifiers. The correct threshold for your specific log corpus must
be confirmed in the pre-build experiment.

### Extraction Config

```json
{
  "log_format": "json",
  "extract": {
    "service":     "$.service",
    "level":       "$.level",
    "status_code": "$.fields.status_code",
    "duration_ms": "$.fields.duration_ms",
    "trace_id":    "$.fields.trace_id",
    "route":       "$.fields.route"
  },
  "never_extract": ["$.fields.user_id", "$.fields.email", "$.fields.request_body"],
  "message_field": "$.message"
}
```

---

## 10. External LLM Integration

*This section replaces the original "LLM Layer" — see ADR-011 for the decision rationale.*

### Design: Infrastructure for AI Agents

LogWeave does not include a built-in LLM. Instead, it exposes structured log intelligence
via REST API and MCP server. Users connect their own LLMs (Claude Code, Cursor, GPT, etc.)
which already have codebase context that a built-in LLM could never match.

**LogWeave provides:** patterns, trends, anomalies, baselines, cross-service correlation.
**User's LLM provides:** root cause analysis, fix suggestions, customer communication.

### MCP Server (`@logweave/mcp`)

Standalone npm package. Runs locally on the developer's machine via stdio transport.
Thin wrapper that translates MCP tool calls into HTTP requests against the LogWeave API.

**7 tools:**

| Tool | Purpose | API Endpoint |
|------|---------|-------------|
| `logweave_overview` | System health summary | `GET /v1/overview` |
| `logweave_error_patterns` | Prioritised error list | `GET /v1/dashboard/templates` |
| `logweave_changes` | New/spiking/resolved patterns | `GET /v1/dashboard/changes` |
| `logweave_template_detail` | Deep dive on one pattern | `GET /v1/templates/:id/detail` |
| `logweave_service_health` | Per-service health report | `GET /v1/services/:name/health` |
| `logweave_search_templates` | Text search on patterns | `GET /v1/templates/search` |
| `logweave_deploys` | Recent deployments | `GET /v1/deploys` |

### REST API (Direct)

The same endpoints power CI/CD gates, Slack bots, custom dashboards, and automation
scripts. No MCP required — any HTTP client works.

### Multi-Tenant Security

- All queries scoped by `tenant_id` from Bearer token auth
- Per-key + per-tenant rate limiting with 429 + Retry-After
- Per-tenant concurrent query limit (max 8)
- ClickHouse resource guardrails (max execution time, memory, rows)

---

## 11. Features & UX

### UX Philosophy: The Product Has to Wow

Five moments that make an engineer say "this is so much better than CloudWatch":

**1. The template list**
```
12 unique error patterns today

  NullPointerException in UserService     ████████  847 occurrences  ↑ 3x normal  NEW TODAY
  Connection timeout to {host}:{port}      ████░░░  234 occurrences  → stable
  Rate limit exceeded (Stripe API)         ██░░░░░   89 occurrences  ↓ trending down
```
Seeing the shape of a day's errors in 3 seconds. CloudWatch cannot do this at all.

**2. Deploy-anchored changes (via MCP or API)**
> Developer asks their LLM: "how does payment-service look after my deploy?"
> LLM calls `logweave_changes` with the deploy timestamp, sees 3 new error patterns,
> cross-references with the git diff, and identifies the root cause.

**3. Slack alerts with context**

CloudWatch: `ERROR count exceeded threshold (value: 847)`

LogWeave: *"NullPointerException in UserService is at 5x normal rate. First seen 14:47 UTC,
3 minutes after your last deployment. New pattern. [View →]"*

**4. MCP-powered investigation**

Developer in their IDE asks their AI assistant: "what's been failing in the last hour?"
The LLM calls `logweave_error_patterns` and gets a structured answer — then correlates
with the codebase to suggest fixes. No built-in LLM needed.

**5. Deploy diff**
```
Since your 14:44 deployment: 3 new error patterns, 2 resolved, volume ↑ 340%
```

### Graduated Anomaly Threshold

The anomaly detector compares current count against a rolling 1-hour baseline. On first
connection, baseline is zero — a fixed 3x threshold would fire on every pattern.

```javascript
const BASELINE_WARMUP_MINUTES = 60
const baselineAgeMinutes = getBaselineAge(tenantId, serviceId)

// Graduated sensitivity: strict during warmup to catch real catastrophes,
// standard after baseline is established
const threshold = baselineAgeMinutes < BASELINE_WARMUP_MINUTES ? 10 : 3
```

**Behaviour:**
- Minutes 0–10: No alerts. Pipeline-alive Slack message at 10 minutes.
- Minutes 10–60: Alerts fire only at 10x baseline — catches crashed services and
  catastrophic deploy failures, filters normal variance on thin data.
- After 60 minutes: Normal 3x threshold.

This proves value during onboarding (a 10x spike during the first hour is almost certainly
real) without a false-positive firehose.

### Slack Daily Summary (Primary Retention Mechanism)

Every morning at 9am — the reason a customer associates the product with value on days
without incidents:

```
📊 LogWeave Daily Summary — payment-service

  🔴 Top errors (last 24h):
     Connection timeout to db-prod   234 occurrences  ↑ 18% vs yesterday
     Rate limit: Stripe API           89 occurrences  → stable

  🆕 New patterns today: 2  |  📉 Resolved since yesterday: 1
  📦 Volume: 12.4GB | 847k events

  💡 "health check OK" fires 2.3M times/day. Sampling at 1% cuts volume 18%.
```

### MVP Features (5-Week Build)

- Full ingestion pipeline: clusterer + pre-processing + ClickHouse
- Dashboard: template list, volume chart, service breakdown, new template count,
  "[unclustered events]" bucket visible when recovery is pending
- "Explain this error" button (NoneAdapter)
- 3 natural language query templates
- Slack anomaly alerts with graduated threshold
- Slack daily summary (9am)
- Model C raw log routing (behind config flag)

---

## 12. Onboarding

### SDK Transport Contract

```
Normal: async send — never blocks application logger

API slow (>2s): send async, does not await

API unreachable:
  Buffer up to 1,000 events in memory
  Retry: 3x exponential backoff (1s, 2s, 4s)
  Beyond limit: drop, console.warn once
  Application continues to all other transports normally

API 4xx: warn once, do not retry
```

```javascript
new LogWeaveTransport({
  apiKey: process.env.LOGWEAVE_KEY,
  bufferSize: 1000,
  timeoutMs: 2000
})
```

### SaaS Onboarding — Model B

**Step 1 — API key:** Issued manually. We talk to every beta customer personally.

**Step 2 — Slack webhook + expectation setting:**
Configure webhook before transport install. Brief the customer: "You'll get a pipeline
confirmation in 10 minutes. Alerts kick in gradually — 10-minute mark is a summary,
real anomaly detection starts at the 1-hour mark once we've built your baseline."

**Step 3 — Install transport (one line):**
```bash
npm install @logweave/transport
```
Start with their noisiest service. We configure extraction on the onboarding call.

**Step 4 — 10-minute pipeline confirmation:**
Slack: *"LogWeave is live. X events across Y unique patterns in payment-service so far.
Anomaly detection starts in ~50 minutes. [View dashboard →]"*

**Step 5 — First real alerts (after 60 minutes):**
Baseline established. 3x threshold active. This is the first "wow" moment in Slack.

**Step 6 — Dashboard walk-through:**
Their own logs, their own patterns. Walk through the template list and one "explain this
error" on their top error pattern.

**Step 7 — Model C opportunity:**
Surfaces automatically when estimated savings exceed $100/month. Informational messaging
for low-volume customers at 60 days. No sales call in either case.

---

## 13. Pricing & Unit Economics

### Per-Service Pricing

**"Service" defined:** What maps to one API key in the transport config. If a customer
routes two services through one transport, they lose service-level dashboard granularity
— a natural disincentive without enforcement overhead.

| Tier | Services | Retention | Price |
|---|---|---|---|
| Beta | Up to 3 | 30 days | $79/month |
| Startup | Up to 5 | 30 days | $79/month |
| Growth | Up to 25 | 90 days | $249/month |
| Scale | Unlimited | 1 year | $799/month |
| Enterprise | Custom | Custom | Custom |

**No free tier until 20 paying customers.**

### Self-Hosted Pricing

| Tier | Services | Price |
|---|---|---|
| Startup | Up to 5 | $59/month |
| Growth | Up to 25 | $199/month |
| Scale | Unlimited | $599/month |

### Customer Cost Comparison

**Model B — 10GB/day:** CloudWatch $164/month + LogWeave $79/month = $243/month.
Capability sale. ROI is time saved per incident.

**Model C — 10GB/day:** S3 $7 + PUT $1.50 + LogWeave $79 = **$87.50/month (47% less)**.

**Model C — 100GB/day:** S3 $69 + PUT $15 + LogWeave $249 = **$333/month (80% less than
CloudWatch's $1,650/month)**.

**Azure Monitor — 100GB/day (Year 2):**

| | Azure Monitor | LogWeave + Blob |
|---|---|---|
| Ingestion | $8,280/month | $0 |
| Storage | ~$100/month | ~$55/month |
| LogWeave | — | $249/month |
| **Total** | **~$8,380/month** | **~$304/month (96% less)** |

### COGS (SaaS)

| | <10 customers | <50 customers | <200 customers |
|---|---|---|---|
| ClickHouse | ~$250/month | ~$450/month | ~$900/month |
| API + clusterer (same VPS) | ~$50/month | ~$150/month | ~$300/month |
| LLM API | $0 | $0 | $0 |
| **Total** | **~$300/month** | **~$600/month** | **~$1,200/month** |

LLM costs dropped to $0 — users bring their own LLM via MCP/API. ClickHouse costs
modestly higher due to MCP query load (~7.5% increase). Break-even: ~4 customers at
$79/month.

---

## 14. Distribution

Distribution is the hardest part of this business. The technical architecture is the cost
of entry. This section gets the same rigour as the architecture sections.

### The Honest Funnel

10 contacts will not reliably produce 5 paying customers. Realistic conversion rates for
a solo founder, no brand, outbound motion, product that requires production infrastructure
changes:

| Stage | Rate | From 30 contacts |
|---|---|---|
| Respond to outreach | 40% | 12 |
| Agree to 15-min demo | 60% | 7 |
| Install the transport | 50% | 3–4 |
| Still active at 30 days | 60% | 2 |
| Pay $79/month | 80% | 1–2 |

**You need 30 initial contacts to reliably produce 2 paying customers.** To reach 5 paying
customers, plan for 60–80 contacts across the first 3 months. This is not discouraging —
it's arithmetic. Plan for it instead of being surprised by it.

### Contact Sources (Ordered by Conversion Probability)

**Tier 1 — Warm network (highest conversion, start here):**
- Engineering managers you know personally or are one introduction away from
- Former colleagues now at startups with AWS usage
- People who have complained to you about CloudWatch specifically
- Target: 10 contacts

**Tier 2 — Warm-ish via shared context:**
- LinkedIn: engineering managers at Series A–B startups, filter by "AWS" in bio or posts
- Twitter/X: search "cloudwatch expensive", "cloudwatch insights terrible", "aws logs cost"
  — find people actively complaining, engage genuinely before pitching
- GitHub: contributors to CloudWatch CLI tools, aws-cdk log-related packages, winston
- Hacker News: "Who is hiring" threads with "CloudWatch" mentions, HN comment threads on
  observability costs where you can contribute value first
- Target: 15–20 contacts from this tier over the first 6 weeks

**Tier 3 — Cold outbound:**
- Job postings mentioning "CloudWatch" and "SRE" or "platform engineering" — company
  clearly uses and thinks about CloudWatch
- AWS case studies and conference talks — companies that have spoken publicly about their
  logging infrastructure
- Target: 10–15 contacts as fill if Tier 1–2 exhausted

### Outreach Sequence

**Message 1 (personalised, 3 sentences):**
> "I saw [specific thing — your tweet about CloudWatch, your talk at re:Invent, your job
> posting mentioning CloudWatch Insights]. I'm building a tool that addresses [specific
> pain they mentioned]. Would you be up for a 15-minute demo on your actual setup?"

Never lead with features. Lead with their specific pain.

**Follow-up at day 5 if no reply (one line):**
> "Bumping this in case it got buried — happy to keep it short."

**No further follow-up.** Two messages max. Move on.

**Demo call (15 minutes):**
1. "Walk me through your last production incident. How did you investigate it?" (5 minutes)
2. Show the template list on synthetic data matching their stack (5 minutes)
3. "If I could show you this on your actual logs in the next 30 minutes, would you try it
   for a month?" (2 minutes)
4. Schedule the integration call or send the transport npm package (2 minutes)

**Integration call (30 minutes):**
Install transport, configure extraction for their log format, set up Slack webhook,
watch first data appear.

**30-day check-in:**
If they're active: invoice. If they've gone quiet: a single message asking what happened.
Their answer is more valuable than chasing payment.

### The Calculator (Run in Parallel with Outreach, Before MVP)

Static page. Input: monthly CloudWatch Logs bill. Output: estimated annual savings with
Model C. CTA: "Leave your email — I'll tell you how."

Build in 2 hours. Run $200 Google Ads against:
- "cloudwatch logs expensive"
- "cloudwatch alternative"
- "cloudwatch insights slow"

**Decision gates:**
- If <5 people enter a real number: pain isn't acute enough or ad targeting is wrong
- If numbers entered but no emails: value prop isn't landing — rework the output message
- If 10+ emails: you have warm leads. Reach out personally within 24 hours.

This is not a lead generation machine. It's a signal test. $200 spent here is the
cheapest market research available.

### What To Do When the First 10 Say No

You will get no from some people who should want this. Diagnose before pivoting:

**Track the no-type:**
- "Not a priority right now" → timing problem, not product problem. Follow up in 3 months.
- "We already use [Datadog/New Relic]" → wrong segment. Refine targeting toward smaller
  companies without full observability spend.
- "We don't use CloudWatch" → wrong segment entirely. Check targeting.
- "Interesting but our logs are too sensitive" → self-hosted tier, position compliance
  properties harder.
- "We'd want to see X feature first" → if 3+ people say the same thing, it's signal.

**Don't pivot on a single no.** Do pivot if 5+ nos share the same reason.

### Content (After First 5 Customers, Not Before)

One blog post: "How we replaced CloudWatch Logs and saved 80%." The Model B → Model C
story as a real engineering experience. Post on your own blog. Submit to Hacker News.
The post does not exist before you have a customer whose story it can tell.

SEO targets (slow burn, Month 3+): "cloudwatch insights alternative", "cloudwatch logs
too expensive", "query logs natural language".

### Open Source SDK

`@logweave/transport` — MIT, published on npm from day one. Engineers discover it through
package searches. The transport sends to any HTTP endpoint — a credible open-source
project, not just a client library with an open-source badge.

---

## 15. Build Roadmap

### Before Building: Validate the Two Highest-Risk Assumptions

Run both in parallel. Neither requires any product code.

**Validation 1 — The Drain3 experiment (timebox: 1 full day):**

Part 1 — Template quality (~4 hours):
Take 10,000 real log lines from production (budget 1–2 hours just for log extraction
if you need to set up credentials, navigate CloudWatch exports, handle pagination — this
step is slower than it sounds). Run three clustering passes:

1. No pre-processing — raw messages to Drain3
2. Pre-processing with `\d{6,}` (default)
3. Pre-processing with `\d{4,}` (more aggressive)

Compare each pass: Are templates meaningfully distinct? Do they group similar messages
correctly? Which threshold produces better templates for your actual logs? Manually inspect
output — there's no automated quality metric.

Part 2 — State recovery (~30 minutes):
Cluster 5,000 messages. Save checkpoint. Kill the process. Restart. Cluster the same
5,000 messages. Verify template IDs match via `template_registry`. If they don't, there
is a checkpoint restore bug to fix before anything else.

Part 3 — Throughput (~30 minutes):
Time the full pre-processing + clustering pipeline for 10,000 messages. If >10 seconds,
the clusterer will bottleneck at modest ingest rates. Profile before building the API
around it.

**If Drain3 does not produce useful templates in one day of focused effort:** stop. This
is the signal that your log format needs different pre-processing, Drain3's parameters
need serious tuning, or Drain3 is not the right tool. One day of validation is cheap
insurance against four weeks on a broken foundation.

**Validation 2 — The calculator + 5 conversations (run concurrently):**

Build the calculator page (2 hours). Run $200 Google Ads. Simultaneously, have 5
conversations with engineering managers: "Walk me through your last production incident."

Both validations should be complete before Week 1a begins. If the Drain3 experiment
fails or the conversations reveal no acute pain, reassess the product direction before
writing infrastructure code.

---

### Week 1a — Clusterer Standalone (Days 1–5)

Focus: `logweave-clusterer` working in isolation. Nothing else.

- [ ] Python environment, FastAPI app, Dockerfile
- [ ] Drain3 wrapper: per-tenant in-memory state, parameter configuration
- [ ] Checkpoint persistence to mounted volume (60s, atomic rename)
- [ ] `template_registry` table in ClickHouse (schema + migrations)
- [ ] `SELECT ... FINAL` for all registry reads; process-level lock on new inserts
- [ ] `POST /cluster` endpoint end-to-end
- [ ] Pre-processing pipeline (regex stripping, configurable patterns)

**End-of-week test:** POST 1,000 messages directly to the clusterer via curl.
Kill and restart. POST the same 1,000 messages. Verify template IDs are stable.
Verify `SELECT ... FINAL` returns consistent results.

---

### Week 1b — API Server + Transport (Days 6–10)

Focus: full ingestion pipeline end-to-end.

- [ ] Express app, Docker Compose wiring (api + clusterer + clickhouse)
- [ ] `log_metadata` table + `template_stats` + `service_stats` materialised views
- [ ] `POST /v1/ingest/batch` with API key auth
- [ ] `extractMetadata()`: parse → extract → never_extract → pre-process → cluster →
      anomaly score → write to ClickHouse
- [ ] Clusterer degradation: 500ms timeout → `template_id=0` → store `pre_processed_message`
      → in-memory re-cluster queue
- [ ] Startup reconciliation query for `template_id=0` rows
- [ ] SDK transport npm package: buffer 1,000, retry 3x, drop + warn

**End-of-week test:** POST 10,000 real log lines via the transport. Verify templates in
ClickHouse, verify `template_id=0` fallback works, verify startup reconciliation
re-clusters pending rows.

---

### Week 2 — Dashboard + Slack (Days 11–15)

- [ ] Slack anomaly alert: 5-min cron, graduated threshold (10x first 60 min, then 3x)
- [ ] 10-minute pipeline-alive Slack message
- [ ] Slack daily summary (9am: top errors, volume, one volume tip)
- [ ] Single-page dashboard (static HTML + Chart.js, served from Express):
  - Template list: sorted by occurrence, sparklines, "new today" badges,
    "[unclustered events]" bucket visible when template_id=0 rows exist
  - Log volume chart (last 24h by service)
  - Service breakdown (error rate, volume per service)
- [ ] Dashboard data API endpoints

---

### Week 3 — LLM-Ready Pivot (Days 16–25)

*Reprioritised: built-in LLM features dropped in favour of API-first + MCP design (ADR-011).*

- [x] ADR-011: drop built-in LLM, adopt API-first + MCP
- [x] Cross-service template query with servicesAffected
- [x] Template text search via template_registry
- [x] Deploy-anchored changes with `since` timestamp param
- [x] Composite API endpoints (overview, template detail, service health)
- [x] Rate limiting (per-key + per-tenant + concurrent query guard)
- [x] Deploy marker API (POST/GET /v1/deploys)
- [x] LLM-friendly response formatting
- [x] MCP server (`@logweave/mcp`) with 7 tools
- [ ] Integration test: MCP server against live stack
- [ ] Update PLAN.md (this change)

---

### Week 4 — Hardening + Model C (Days 21–25)

- [ ] Model C: raw log write to customer S3 (AWS SDK `PutObject`, behind config flag)
- [ ] Rate limiting (in-memory, 1000 req/min per key)
- [ ] Request validation (schema check on ingest payload)
- [ ] `docker-compose.yml` + `.env.example` for self-hosted
- [ ] ClickHouse startup migration runner (versioned SQL, idempotent)

**Deliverable:** 3-container Docker Compose stack that receives logs via winston transport,
extracts patterns, shows a dashboard, surfaces intelligence via API/MCP, and alerts on
anomalies. Works identically as SaaS or self-hosted.

---

### Week 5 — Second Language (Days 26–?)

Allow one week of buffer. Real builds always surface integration issues. Use it for:
- Bug fixes discovered in Week 4 integration
- First customer onboarding prep
- CloudWatch and S3 adapter work once a real customer's log format is known

---

### Week 6+ — First Customer

- [ ] CloudWatchAdapter (richer explain from real log samples)
- [ ] S3Adapter
- [ ] Ship transport to first customer
- [ ] Configure extraction for their log format
- [ ] Issue API key, configure Slack webhook, walk through graduated alert behaviour
- [ ] Monitor, fix bugs, iterate daily
- [ ] After 30 days: Stripe invoice for $79/month
- [ ] Onboard 2–4 more beta customers

---

### Phase 2 (Month 3–6, Customer-Driven)

- [ ] Model C onboarding flow (savings-triggered, CloudFormation one-click)
- [ ] Deploy diff (deployment webhook → template comparison)
- [ ] Volume reduction recommendations
- [ ] Self-serve extraction config UI
- [ ] Python logging handler (first Python customer)
- [ ] PagerDuty integration
- [ ] Self-serve signup + auth (when manual onboarding >30 min/week)

### Phase 3 (Month 6–12)

- [ ] Azure Monitor + Blob adapters (first Azure customer)
- [ ] Free tier (after 20 paying customers)
- [ ] AWS Marketplace listing (after stable product + 10 paying customers)
- [ ] Zero-config anomaly detection (7-day baseline, day-of-week aware)
- [ ] Contextual alerts (LLM explanation in alert body)
- [ ] Saved queries and team sharing
- [ ] SQS + worker architecture (when direct processing bottlenecks)
- [ ] SOC2 Type II preparation

---

## 16. Self-Hosted Deployment

### Docker Compose

```yaml
services:
  logweave-api:
    image: logweave/api:latest
    ports:
      - "3000:3000"
    environment:
      - LOGWEAVE_MODE=selfhosted
      - LOGWEAVE_CLICKHOUSE_URL=clickhouse://clickhouse:9000/logweave
      - LOGWEAVE_CLUSTERER_URL=http://logweave-clusterer:8000
      - LOGWEAVE_CLUSTERER_TIMEOUT_MS=500
      - LOGWEAVE_RATE_LIMIT_RPM=600
      - LOGWEAVE_LICENSE_KEY=${LICENSE_KEY}
      - LOGWEAVE_LOG_SOURCE=${LOG_SOURCE:-none}
      - LOGWEAVE_RAW_DESTINATION=${RAW_DESTINATION:-none}
      - LOGWEAVE_RAW_S3_BUCKET=${RAW_S3_BUCKET:-}
      - LOGWEAVE_DEFAULT_TENANT=default
    depends_on: [clickhouse, logweave-clusterer]

  logweave-clusterer:
    image: logweave/clusterer:latest
    volumes:
      - clusterer_state:/data/drain3
    environment:
      - DRAIN3_CHECKPOINT_DIR=/data/drain3
      - DRAIN3_CHECKPOINT_INTERVAL=60

  clickhouse:
    image: clickhouse/clickhouse-server:24.3
    volumes:
      - clickhouse_data:/var/lib/clickhouse
    ulimits:
      nofile: { soft: 262144, hard: 262144 }

volumes:
  clickhouse_data:
  clusterer_state:
```

### Licensing

Signed JWT via Stripe subscription. Validated on startup, works offline. 7-day grace
period after expiry. No telemetry. Customer's data stays in their infrastructure.

### Compliance

- All data in customer's infrastructure
- LLM calls go directly from their instance to their provider
- Zero visibility from us — no telemetry, no phone-home
- HIPAA, GDPR, PCI resolved by architecture

---

## 17. Multi-Cloud Extension

The Docker Compose stack has zero cloud dependencies. Runs on AWS, Azure, GCP, bare metal,
a laptop.

### Log Source Adapters

| Cloud | Adapters | Effort |
|---|---|---|
| AWS | CloudWatchAdapter + S3Adapter | Week 6 |
| Azure | AzureMonitorAdapter + AzureBlobAdapter | ~3 days |
| GCP | GCPLoggingAdapter + GCSAdapter | ~3 days |

### Model C Raw Routing

MVP: AWS SDK `PutObject` directly. No abstraction layer.

When a second cloud is needed: add that cloud's SDK. Evaluate OpenDAL (covers S3, Azure
Blob, GCS, and others) only when a third backend is on the horizon.

```
LOGWEAVE_RAW_DESTINATION=s3      → AWS SDK (MVP)
LOGWEAVE_RAW_DESTINATION=azure   → Azure SDK (when needed)
LOGWEAVE_RAW_DESTINATION=gcs     → GCS SDK (when needed)
```

---

## 18. Scaling Path

| Trigger | Change | Effort |
|---|---|---|
| Clusterer response >500ms consistently | Profile; scale vertically | 1 day |
| Clusterer >80% CPU | Vertical scale | 1 hour |
| API ingest response >500ms | Background queue (Bull/BullMQ, same Compose) | 1 week |
| ClickHouse >80% CPU | Vertical scale | 1 hour |
| >20 tenants, mixed load | ClickHouse resource management | 2 days |
| Queue at throughput limit | SQS + Fargate workers | 1–2 weeks |
| >100 tenants or >500GB/day | ClickHouse sharding | 2–4 weeks |
| Clusterer state unmanageable | Shard clusterer by tenant_id hash | 1–2 weeks |

Don't add any of these until the trigger is actually hit.

---

## 19. Validation Assumptions

### Pre-Build

**Drain3 experiment** — 1 full day. Three parts: template quality (3 variants), state
recovery (kill/restart/verify), throughput (time 10K messages). If useful templates
don't emerge in one day, stop and diagnose before building.

**Calculator + conversations** — $200 Google Ads + 5 conversations simultaneously with
the Drain3 experiment. Both gates must pass before Week 1a begins.

### During Beta

1. Drain3 templates remain useful on real customer logs (first customer may differ from
   your production logs)
2. Engineers install the transport within 2 weeks of a demo (if <3/10 do, consider sidecar)
3. Metadata ratio stays below 10% of raw log volume
4. 3 query templates cover most incident questions (expand if >50% unanswered)
5. NoneAdapter explain feature useful enough (repeat clicks = working)
6. Model C conversion: >20% convert within 30 days of savings surfacing
7. Graduated alert threshold lands well: "I liked that it didn't spam me in the first hour"
   is the target response, not "I wondered if it was broken"

---

## 20. What Not to Build Yet

| Skip | Revisit when |
|---|---|
| CloudWatch/S3 adapters in MVP | Week 6 with first customer |
| SQS / message queue | API response time >500ms |
| OpenDAL | Second cloud backend needed |
| Python SDK | First Python customer |
| Self-serve signup/auth | Manual onboarding >30 min/week |
| Extraction config UI | >10 customers |
| Free tier | 20 paying customers |
| AWS Marketplace listing | 10+ paying customers + stable product |
| Kafka / Redpanda | >1TB/day |
| ClickHouse sharding | >500GB/day metadata |
| Azure/GCP adapters | First Azure/GCP customer |
| Free-form SQL | Template gaps become churn |
| SOC2 Type II | Enterprise prospects require it |

---

## 21. Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| SDK | Winston transport (Node.js, MIT) | Buffer + retry + failover by contract |
| API server | Express.js (Node.js) | Ingestion, query, dashboard — one process |
| MCP server | `@logweave/mcp` (Node.js, stdio) | 7 tools for AI assistant integration |
| Log clustering | Drain3 via `logweave-clusterer` (Python / FastAPI) | Per-tenant state, 60s checkpoint, 500ms degradation |
| Template IDs | `template_registry` (ClickHouse, ReplacingMergeTree) | `SELECT ... FINAL`; stable IDs across restarts |
| Unclustered recovery | `pre_processed_message` column + startup reconciliation | Closes data loss gap from clusterer outages |
| Pre-processing | Regex pipeline (in API server, before clusterer call) | `\d{6,}` default threshold; validated in pre-build experiment |
| Metadata store | ClickHouse (single node, Docker) | Shared table, tenant_id partitioned, TTL retention |
| Dashboard | React / Vite SPA + Tailwind + ECharts | Served from Express |
| External LLM | User's own (via MCP or REST API) | No built-in LLM — see ADR-011 |
| Log source read-back | `LogSourceAdapter` interface | NoneAdapter default; S3 connector designed (ADR-010) |
| Raw log routing (Model C) | AWS SDK `PutObject` | OpenDAL added when second cloud needed |
| Alerting | Slack webhook | Graduated threshold (10x → 3x). Daily summary 9am. |
| Rate limiting | Hand-rolled sliding window | Per-key + per-tenant + concurrent query guard |
| Billing (SaaS) | Stripe manual invoicing → Stripe Billing | Manual for first 20 |
| Billing (self-hosted) | Stripe + signed JWT license key | Offline-capable |
| Deployment | Docker Compose (3 containers) | api + clusterer + clickhouse |

---

## One-Paragraph Pitch

> "We're the log intelligence layer your AI agent queries. Add one line to your winston
> config and your logs get pattern detection, anomaly alerts, and structured intelligence
> — queryable via REST API or MCP server. Your AI assistant already knows your codebase;
> LogWeave tells it what's happening at runtime. Together, they diagnose production issues
> faster than any dashboard. We never store your raw log content — we extract patterns
> and discard the rest. When you're ready, redirect logs from CloudWatch to S3 and save
> 50–80% on log costs. Per-service pricing, not per-gigabyte. SaaS or self-hosted."

---

## The Honest Version

This is a product built by one person. The first version is a Docker Compose stack with
three containers: an Express server, a Python clustering service, and ClickHouse. The
honest build timeline is 5 weeks, not 4.

Before writing any code: spend one day running Drain3 on real logs. Run the calculator
experiment and 5 conversations in parallel. If the templates aren't useful, fix that
first. If nobody leaves their email and every conversation says "we use grep and it's
fine," the product is solving a problem that isn't painful enough to pay for.

Distribution is the hard part. The architecture is the cost of entry. Plan for 60–80
outreach contacts across 3 months to reliably reach 5 paying customers. Start outreach
before the MVP is finished.

If two of the first five customers keep paying after month 2, this is a real product.
If not, the experiment cost five weeks and $320 in hosting.

---

*V8 completed: March 2026*
*Supersedes V7. Incorporates: seventh-round Opus adversarial review, unclustered row*
*recovery via pre_processed_message column, SELECT ... FINAL for template_registry,*
*Week 1a/1b split and honest 5-week timeline, graduated anomaly threshold (10x→3x),*
*low-volume Model C informational messaging, 1-day pre-build timebox, two-language*
*overhead acknowledged, distribution rewritten as a first-class section with funnel*
*numbers, outreach sequence, and contingency planning.*
