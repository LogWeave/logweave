# Product Strategy: LLM-Ready API & MCP Surface (v2)

*Revised 2026-03-20 after 9 review rounds: adversarial architect, security analyst,
SRE persona, platform engineer persona, developer+AI team persona, support persona,
killer features brainstorm. All scores rated against the status quo (CloudWatch + manual
investigation), not against an ideal tool.*

---

## Strategic Intent

LogWeave is not an AI-powered log analysis tool. It is **infrastructure for AI agents**.

Users' LLMs already know their codebase, architecture, and deployment history — context
a built-in LLM can never match. LogWeave provides the structured runtime intelligence
half: patterns, trends, anomalies, baselines. The user's toolchain provides the code
context half. Together, they are dramatically better than either alone — and better than
any existing observability tool, because no other tool puts runtime pattern intelligence
and codebase context in the same context window.

This drops all built-in LLM features (classification, explanation, NL query) and makes
the REST API + MCP server the primary product surface. The dashboard continues as the
human visual interface.

### What We Build vs What We Don't

| Capability | Who does it | Why |
|-----------|------------|-----|
| Pattern extraction & clustering | **LogWeave** | Drain3 has no equivalent in the user's stack |
| Anomaly detection & baselines | **LogWeave** | Requires persistent observation over weeks |
| Cross-service correlation | **LogWeave** | Temporal pattern matching across services |
| Pattern evolution & trends | **LogWeave** | Longitudinal data only we persist |
| Template vocabulary (system fingerprint) | **LogWeave** | Machine-learned, impossible to derive from code |
| Root cause analysis | **User's LLM** | Requires codebase context we don't have |
| Fix suggestions & code changes | **User's LLM** | Can read code and write patches |
| Customer communication drafting | **User's LLM** | Knows tone, context, history |
| Runbook execution | **User's LLM** | Can read runbooks and follow steps |
| Impact assessment (business) | **User's LLM** | Knows which services serve which customers |
| Impact assessment (operational) | **LogWeave** | Knows which services are actually affected |
| Raw log drill-down | **LogWeave** (on-demand) | Fetches from customer's S3 via ADR-010 connector |

### The Strategic Moat

Three things that compound over time and cannot be replicated by an LLM reading code:

1. **Template vocabulary** — a machine-learned description of everything the system says
   at runtime. After 30 days of real traffic, the vocabulary stabilises. A new template on
   day 31 is genuinely novel. This signal-to-noise ratio is impossible on day 1.

2. **Behavioral baselines** — what "normal" looks like for each pattern, at each time of
   day, each day of week. Calibrated against actual traffic, not theoretical behavior. After
   90 days, baselines capture monthly cycles (billing runs, quarterly loads). Alert accuracy
   improves continuously without configuration.

3. **Longitudinal record** — how patterns evolve, appear, disappear, spike, and resolve
   over months. "This pattern first appeared 47 days ago and has been growing 4% per week"
   is a statement only persistent observation can produce. The user's LLM provides the "so
   what" (reads the code, suggests the fix); LogWeave provides the trajectory.

---

## Target Personas

### Primary: Developer with AI Coding Assistant

The MVP persona. They use Claude Code, Cursor, or similar. Their LLM already knows
their codebase. LogWeave gives their LLM runtime intelligence.

**Magic moment:** Developer deploys a change at 2:14 PM. Asks their LLM "how does
payment-service look after my deploy?" The LLM calls LogWeave, sees 3 new error patterns
since 2:14 PM, cross-references with the git diff, and says: "Your deploy changed the
connection pool config in checkout.ts. The new error pattern 'Connection to {host}
refused after {duration}ms' suggests the pool size is too small. Here's the fix."

Neither tool alone can do this. LogWeave provides the symptoms; the LLM provides the
diagnosis and remedy.

### Secondary: SRE / On-Call Engineer

Uses the same API + MCP tools. Their workflow is higher-urgency: paged at 2am, needs
fast triage. LogWeave tells them "what" and "how bad"; their LLM tells them "why" and
"what to do."

**Scored 7.0/10** against current CloudWatch workflow. Path to 10: deploy markers (+1.5),
raw log samples via S3 connector (+0.5, planned Week 5), custom alert thresholds (+0.5,
planned Week 4), trace correlation (+0.5).

### Secondary: Platform Engineer

Uses the REST API directly (not MCP) for CI/CD gates, automation, internal tooling.
Can build a deploy quality gate TODAY with curl + jq against existing endpoints.

**Scored 6.5/10** against current CloudWatch + Lambda approach. Path to 10: webhooks
(+1.5), `since` param (+0.5), Prometheus metrics (+1.0).

### Secondary: Support Engineer (non-technical)

Does NOT use MCP or the API directly. Needs a Slack bot or AI assistant that queries
LogWeave and responds in plain English with green/yellow/red confidence indicators.

**Scored 7.0/10 with AI assistant, 3.0/10 with dashboard alone.** The AI assistant is
the interface for this persona — it translates between customer language ("your API is
slow") and LogWeave data (pattern spikes, error rates).

**Killer feature they described:** Type the customer's complaint in plain English → get
back a severity assessment, a suggested customer response, and an escalation button.
LogWeave provides the facts; the LLM composes the message.

---

## Three Consumers, One API

```
Platform engineer → curl /v1/dashboard/templates → JSON
MCP server        → calls /v1/dashboard/templates → formats for LLM
Dashboard         → fetches /v1/dashboard/templates → renders charts
Support Slack bot → calls /v1/dashboard/overview  → green/yellow/red
```

The REST API is the product. Everything else is a consumer.

---

## User Stories

### MVP — Theme 1: MCP Server

**S1. Connect LogWeave as an MCP server**
*As a developer, I want to add LogWeave as an MCP server so my AI assistant can query
log intelligence as a native tool.*

- `@logweave/mcp` published as npm package
- Config: `{ "command": "npx", "args": ["@logweave/mcp"], "env": { "LOGWEAVE_API_URL": "...", "LOGWEAVE_API_KEY": "..." } }`
- Lists all available tools with descriptions on connect
- Connection established in <2s (after initial package download)
- Auth failure returns clear error, not silent failure
- HTTP timeout: 5s per API call, 10s for composite tools
- Partial failure in composite tools returns available data + error flag
- Connection check on startup — fail fast with clear message
- Sends `User-Agent: @logweave/mcp/<version>` on all requests
- All input fields optional with sensible defaults (additive schema evolution)
- Client-side rate limit handling: surfaces 429 clearly to LLM with retry guidance

**S2. Get system overview**
*As a developer, I want to ask "what's happening?" and get a structured health summary.*

Tool: `logweave_overview` | Input: `{ hours?: number }` (default: 24)
Returns: totalEvents, totalTemplates, newTemplatesToday, errorRate, serviceCount,
top 5 error patterns with occurrence counts, trend direction, and services affected.

- Response fits within 2K tokens (MCP tool truncates long template texts to 200 chars)
- Includes `meta.timeRange` ("last 24 hours ending at 2026-03-20T14:00Z")
- Includes `meta.dataRetention` ("data covers up to 30 days")
- Error patterns include trend text ("rising 3.2x", "stable", "falling")
- Empty results include contextual message
- Returns in <500ms

**S3. List error patterns**
*As a developer, I want a prioritized list of errors so I can focus on what matters.*

Tool: `logweave_error_patterns` | Input: `{ hours?: number, service?: string, limit?: number }`
Returns: Templates sorted by occurrence, with: templateText, occurrenceCount, errorCount,
trend, firstSeen, lastSeen, servicesAffected[], isNewToday.

- `servicesAffected` field requires new cross-service query (groups by template_id, not template_id+service)
- Filterable by service
- Returns in <500ms

**S4. See what changed (deploy-anchored)**
*As a developer, I want to ask "what changed after my deploy at 2pm?" and see the diff.*

Tool: `logweave_changes` | Input: `{ hours?: number, service?: string, since?: ISO8601 }`
Returns: Grouped by type — new templates, spiking templates (with ratio), resolved.

- `since` accepts ISO8601 timestamp
- When `since` is provided: current window = [since, now], previous window = [since - duration, since]
- Spikes include ratio ("5.2x normal")
- New patterns flagged distinctly from spikes
- Returns in <500ms

**S5. Deep dive on a specific pattern**
*As a developer, I want comprehensive detail on one template.*

Tool: `logweave_template_detail` | Input: `{ template_id: string, hours?: number }`
Returns: templateText, occurrence history (hourly buckets), status code distribution,
servicesAffected[], firstSeen, lastSeen, trend, anomalyScore, sourceRefs (pointers to
raw logs — fetchable via S3 connector in Week 5).

- Single tool call returns all relevant data (composite API endpoint, not multiple HTTP calls)
- Returns in <500ms

**S6. Check service health**
*As a developer, I want a focused health report for one service.*

Tool: `logweave_service_health` | Input: `{ service: string, hours?: number }`
Returns: logCount, errorCount, errorRate, warnRate, topErrorPatterns (limit 5),
volumeTrend (hourly buckets).

- Composite API endpoint
- Returns in <500ms

**S7. Search for patterns by text**
*As a developer, I want to search template text to investigate a class of errors.*

Tool: `logweave_search_templates` | Input: `{ query: string, hours?: number, limit?: number }`
Returns: Matching templates with stats.

- Searches `template_registry` (one row per template), NOT `template_stats` (millions of rows)
- Case-insensitive search with minimum 3-character query length
- Add `ngrambf_v1(3, 512, 2, 0)` skip index on `template_text` in registry
- No regex injection — query is sanitised and parameterised
- Returns in <500ms for up to 100K templates

### MVP — Theme 2: API Hardening

**S8. Rate limiting for bot/LLM access**
*As a platform operator, I want rate limits that protect the service from LLM query loops.*

- Per-API-key limit: 60 req/min reads (SaaS), 600 req/min (self-hosted, configurable)
- Per-tenant ceiling: 120 req/min (hard cap regardless of key count)
- 429 response with `Retry-After` header
- Rate limit headers on every response (`X-RateLimit-Limit`, `Remaining`, `Reset`)
- Ingest endpoint has separate, higher limit
- Per-tenant concurrent query limit: max 8 concurrent ClickHouse queries (simple semaphore)
- Resource guardrails fail hard on startup if they cannot be applied (not warn)

**S9. LLM-friendly response formatting**
*As a developer whose LLM consumes responses, I want enough context for correct interpretation.*

- Every response includes `meta.timeRange` and `meta.dataRetention`
- Trend fields are human-readable strings ("rising 3.2x", "stable", "falling")
- Empty results include contextual message
- MCP tool truncates template_text to 200 chars max, sets `truncated: true`
- Raise MAX_HOURS from 168 (7 days) to 720 (30 days) for read endpoints

### MVP — Theme 3: Deploy Awareness

**S10. Deploy marker API**
*As a developer, I want to record deployments so LogWeave can anchor "what changed" to
deploy events.*

- `POST /v1/deploys` — `{ service: string, version?: string, commitSha?: string, timestamp?: ISO8601 }`
- Stored in new `deploys` ClickHouse table (simple MergeTree, TTL 90 days)
- `logweave_changes` can accept `deploy_id` as alternative to `since`
- `logweave_deploys` MCP tool: list recent deploys per service
- Lightweight — no new infrastructure, just an INSERT and a SELECT

### Deferred

| Story | Milestone | Reasoning |
|-------|-----------|-----------|
| Raw log drill-down via S3 connector | Week 5 | ADR-010 fully designed; real work (STS, streaming regex). MCP tools valuable without it |
| Alert history query | Week 4 | Needs alert history table + Alarms tab |
| Custom per-watch thresholds | Week 4 | Part of Alarms milestone |
| Webhooks / push-based events | Week 5+ | Platform eng's #1 ask; generalise SlackObserver pattern |
| Scoped API keys (read-only vs admin) | Pre-second multi-team customer | Current auth works for MVP |
| Prometheus `/metrics` endpoint | Week 5 | Platform eng asks; replace in-memory counters |
| OpenAPI spec | Post-MCP stabilisation | Zod schemas are readable; auto-generate later |
| Trace-based correlation | Future | `trace_id` captured but not queried; high value, moderate effort |
| Slack bot for support | Week 4-5 | Traffic light concept; small service or Slack Workflow |
| Support-friendly dashboard view | Week 4-5 | Green/yellow/red status page; React component |
| Deploy diff in dashboard | Future | Visual before/after comparison anchored to deploy markers |
| Dynamic rate limiting | Future | Need real usage data before designing adaptive throttling |
| Dead pattern detection | Future | Templates that stopped appearing = potentially dead code |
| Environment diff (staging vs prod) | Future | Compare template distributions across environments |

---

## Feasibility Assessment

### What Exists Today

The heavy lifting is done. We have:
- 15+ dashboard REST endpoints with structured JSON responses
- ClickHouse schema: 5 tables, 2 materialised views
- Bearer token auth with tenant isolation (multiple keys per tenant supported)
- Consistent response envelope (`{ data, meta }`) with Zod validation
- Anomaly detection with graduated thresholds
- Watch/alert system with Slack integration
- 255 passing tests, 0 regressions

### What's Missing

| Story | Exists Today | What's New | Risk |
|-------|-------------|-----------|------|
| S1: MCP server | Nothing | New npm package, MCP SDK integration | **Medium** |
| S2: Overview tool | `/v1/dashboard/overview` | Cross-service template aggregation, trend text | **Medium** — new query shape |
| S3: Error patterns | `/v1/dashboard/templates` | `servicesAffected` field (new GROUP BY) | **Medium** — new query shape |
| S4: Changes + since | `/v1/dashboard/changes` | `since` param, rewrite WHERE clauses on 3 queries | **Medium** — not trivial |
| S5: Template detail | Sparklines + status codes separate | Composite API endpoint combining them | **Low** |
| S6: Service health | Services + volume separate | Composite API endpoint | **Low** |
| S7: Template search | Nothing | Query against `template_registry` + skip index | **Medium** — new code path from API to registry |
| S8: Rate limiting | Nothing | In-memory limiter, per-key + per-tenant + concurrent | **Low** — well-understood pattern |
| S9: Response formatting | Structured JSON exists | Trend text, meta fields, MAX_HOURS change | **Low** |
| S10: Deploy markers | Nothing | New table, 2 endpoints, wire into changes | **Low** — simple CRUD |

### Flags

- **New dependency**: `@modelcontextprotocol/sdk` — needs user approval
- **New dependency**: rate limiting library (or hand-roll with Map + setInterval)
- **Schema addition**: `deploys` table (new, no migration of existing tables)
- **Schema addition**: `ngrambf_v1` skip index on `template_registry.template_text`
- **No breaking changes** to existing API
- **No new infrastructure** — MCP server runs client-side

### What Gets Dropped from PLAN.md

| Feature | Status | Replacement |
|---------|--------|-------------|
| Section 10: LLM Layer (entire section) | **DROP** | User's own LLM via MCP/API |
| Claude Haiku query classification | **DROP** | MCP tools with structured inputs |
| Claude Sonnet "explain this error" | **DROP** | User's LLM + template data + codebase |
| 3 NL query templates | **DROP** | 8 MCP tools with structured inputs |
| `LOGWEAVE_LLM_*` env vars (4 vars) | **DROP** | Not needed |
| `/v1/query`, `/v1/explain/:id` endpoints | **DROP** | MCP tools |

PLAN.md sections to update: 6 (env vars), 10 (entire section), 11 (features — reframe
"natural language" as MCP), 13 (COGS — LLM cost drops to $0), 16 (self-hosted compose —
remove LLM env vars), 21 (tech stack table).

### MCP Server Architecture

```
Developer's machine                    LogWeave infrastructure
┌─────────────────────┐                ┌──────────────────────┐
│ Claude Code / Cursor │                │ Docker Compose       │
│   ↕ MCP protocol     │                │  ├── logweave-api    │
│ @logweave/mcp        │── HTTP/REST ──→│  ├── logweave-clust  │
│   (runs locally)     │                │  └── clickhouse      │
└─────────────────────┘                └──────────────────────┘
```

Standalone npm package. Runs locally via stdio transport. Thin wrapper: translates
MCP tool calls → HTTP requests → structured responses. No changes to Docker Compose.

Composite tools (overview, template_detail, service_health) call **composite API
endpoints** (server-side parallelisation), NOT multiple sequential HTTP calls from
the MCP server. This preserves the 500ms SLA and avoids consuming 2-3 rate limit
slots per tool call.

### Cost Impact

COGS model survives. MCP adds ~7.5% to average query volume. LLM cost drops to $0
(was $20-400/month). Net effect: modest ClickHouse cost increase offset by eliminating
LLM API spend. Peak concurrent load (10 tenants investigating simultaneously) is the
real risk — mitigated by per-tenant concurrent query limit (cap at 8).

---

## Milestone Structure

### Week 3a — API Hardening + New Endpoints

Focus: make the existing API ready for external machine consumption.

1. ADR: Drop built-in LLM, adopt API-first + MCP design
2. Cross-service template query function (`groupArray(DISTINCT service)`)
3. Template text search via `template_registry` + ngram skip index
4. `since` timestamp param for changes endpoint (all 3 change queries)
5. Deploy marker API (`POST /v1/deploys`, `GET /v1/deploys`)
6. Composite API endpoints (template detail, service health, overview)
7. Raise MAX_HOURS to 720 for read endpoints
8. LLM-friendly response formatting (trend text, time range, retention, truncation)
9. Per-key + per-tenant rate limiting with 429 + Retry-After
10. Per-tenant concurrent query limit (semaphore, cap at 8)

### Week 3b — MCP Server + Integration

Focus: ship the MCP server and validate with real usage.

1. MCP server scaffold (`@logweave/mcp`, tool definitions, error handling)
2. MCP tools: overview + error patterns + changes + deploys
3. MCP tools: template detail + service health + search
4. MCP server: auth, User-Agent header, client-side rate limit handling
5. Integration test: MCP server against live LogWeave stack
6. Update PLAN.md: sections 6, 10, 11, 13, 16, 21
7. **GATE: do not publish `@logweave/mcp` to npm until rate limiting is deployed**

---

## Open Questions

1. **Rate limiting library vs hand-rolled?** Simple Map + sliding window is ~50 lines.
   A library adds a dependency. Leaning toward hand-rolled given the solo maintainer
   constraint.

2. **MCP server caching?** Short TTL (30s) cache in the MCP server could reduce API load
   when LLMs call the same tool multiple times in one conversation. Or leave caching to
   the API layer. Leaning toward no caching for MVP — keep the MCP server stateless.

3. **Deploy markers — auto-detection vs manual?** The `POST /v1/deploys` endpoint is
   manual (CI pipeline calls it). Future: detect deploys from template pattern shifts
   automatically. Manual is sufficient and correct for MVP.

4. **Composite endpoints — new routes or query params?** Options:
   - New routes: `GET /v1/templates/:id/detail` (returns sparklines + status codes + meta)
   - Query param: `GET /v1/dashboard/templates?id=X&include=sparklines,statusCodes`
   - Leaning toward new routes — cleaner, independently cacheable.

---

## Appendix: Persona Review Scores

*All scores rated against the status quo (CloudWatch + manual investigation), where
10 = "groundbreaking impact on my day" and 1 = "noise."*

| Persona | Score | Key insight |
|---------|-------|------------|
| SRE (incident response) | 7.0/10 | "Pattern clustering alone saves 5-10 min per incident" |
| Platform eng (automation) | 6.5/10 | "I would adopt this and build on it" — wrote working deploy gate in curl+jq |
| Junior dev (on-call) | 7.0/10 | LLM + patterns + code context is genuinely powerful at 2am |
| Eng lead (Monday check) | 7.0/10 | Changes summary is exactly what they want |
| Senior dev (cross-service) | 7.0/10 | Good triage; raw log drill-down via S3 connector (Week 5) closes the depth gap |
| Support (with AI assistant) | 7.0/10 | AI translates between customer language and LogWeave data |
| Support (dashboard only) | 3.0/10 | Dashboard speaks developer language; Slack bot planned Week 4-5 |
| Mid-level dev (bug report) | 5.0/10 | Can't answer "what happened to THIS customer" — inherent to metadata-only model |

**Average (excluding dashboard-only support): 6.6/10 as MVP, with clear path to 8+.**

### What Each Persona Said Would Hit 10

| Persona | +1 each | Milestone |
|---------|---------|-----------|
| SRE | Deploy markers, raw log samples, custom thresholds, trace correlation, rate limits | Wk3, Wk5, Wk4, Future, Wk3 |
| Platform eng | Webhooks, `since` param, Prometheus, key scoping, bulk queries | Wk5+, Wk3, Wk5, Future, Future |
| Dev team | Deploy awareness, support-friendly view, Slack bot | Wk3, Wk4-5, Wk4-5 |
| Support | Slack bot, system status indicator, escalation workflow | Wk4-5, Wk4-5, Wk4-5 |
