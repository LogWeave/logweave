# ADR-011: Drop Built-In LLM, Adopt API-First + MCP Design

**Status:** Accepted
**Date:** 2026-03-20

## Context

PLAN.md Section 10 specified a built-in LLM layer: Claude Haiku for query classification
and slot-filling, Claude Sonnet for "explain this error" generation, and 3 natural language
query templates. This required 4 environment variables (`LOGWEAVE_LLM_PROVIDER`,
`LOGWEAVE_LLM_API_KEY`, `LOGWEAVE_LLM_MODEL_FAST`, `LOGWEAVE_LLM_MODEL_CAPABLE`) and
two planned endpoints (`/v1/query`, `/v1/explain/:id`).

During Week 3 planning, we identified a fundamental problem with this approach: **a built-in
LLM can never match the context that the user's own LLM already has**. The user's AI
assistant (Claude Code, Cursor, etc.) already knows their codebase, architecture, deployment
history, and runbooks. Our built-in Sonnet can only see template patterns and metadata — it
cannot correlate a new error pattern with a recent code change, suggest a fix, or draft a
customer communication.

The insight: LogWeave should provide the **structured runtime intelligence** (patterns,
trends, anomalies, baselines) and let the user's toolchain provide the **codebase context**.
Together, they are dramatically better than either alone — and better than any existing
observability tool, because no other tool puts runtime pattern intelligence and codebase
context in the same LLM context window.

This was validated through 9 review rounds (adversarial architect, security analyst, 4
persona reviews, killer features brainstorm) documented in `docs/plans/strategy-61.md`.

## Decision

### What We Drop

| Feature | Replacement |
|---------|-------------|
| PLAN.md Section 10 (LLM Layer) | User's own LLM via MCP/API |
| Claude Haiku query classification | MCP tools with structured inputs |
| Claude Sonnet "explain this error" | User's LLM + template data + codebase context |
| 3 NL query templates | 7 MCP tools with structured inputs |
| `LOGWEAVE_LLM_PROVIDER` env var | Not needed |
| `LOGWEAVE_LLM_API_KEY` env var | Not needed |
| `LOGWEAVE_LLM_MODEL_FAST` env var | Not needed |
| `LOGWEAVE_LLM_MODEL_CAPABLE` env var | Not needed |
| `/v1/query` endpoint | MCP tools |
| `/v1/explain/:id` endpoint | `logweave_template_detail` MCP tool |

None of these features were implemented — they were planned for the original Week 3
(Intelligence milestone). No code needs to be removed.

### What We Build Instead

**Three consumers, one API:**

```
Platform engineer → REST API (curl, scripts, CI/CD)
MCP server        → REST API (thin wrapper for LLM tool calling)
Dashboard         → REST API (React SPA, existing)
```

The REST API is the product. The MCP server (`@logweave/mcp`) is a standalone npm package
that runs locally on the developer's machine, translating MCP tool calls into HTTP requests
against the LogWeave API. No changes to Docker Compose — no 4th container.

**7 MCP tools:**

| Tool | What it provides | API endpoint |
|------|-----------------|-------------|
| `logweave_overview` | System health summary | `GET /v1/overview` (composite) |
| `logweave_error_patterns` | Prioritised error list with servicesAffected | `GET /v1/dashboard/templates` (cross-service) |
| `logweave_changes` | New/spiking/resolved since timestamp or deploy | `GET /v1/dashboard/changes` (with `since`) |
| `logweave_template_detail` | Deep dive on one pattern | `GET /v1/templates/:id/detail` (composite) |
| `logweave_service_health` | One service health report | `GET /v1/services/:name/health` (composite) |
| `logweave_search_templates` | Text search on template patterns | `GET /v1/templates/search` (new) |
| `logweave_deploys` | Recent deployment markers | `GET /v1/deploys` (new) |

### What We Build vs What We Don't

| Capability | Owner | Reasoning |
|-----------|-------|-----------|
| Pattern extraction & clustering | **LogWeave** | Drain3 has no equivalent in user's stack |
| Anomaly detection & baselines | **LogWeave** | Requires persistent observation over weeks |
| Cross-service correlation | **LogWeave** | Temporal pattern matching across services |
| Pattern evolution & trends | **LogWeave** | Longitudinal data only we persist |
| Raw log drill-down (on-demand) | **LogWeave** | Fetches from customer's S3 via ADR-010 |
| Root cause analysis | **User's LLM** | Requires codebase context we don't have |
| Fix suggestions | **User's LLM** | Can read code and write patches |
| Customer communication | **User's LLM** | Knows tone, context, history |
| Runbook execution | **User's LLM** | Can read runbooks and follow steps |

### The Strategic Moat

Three things that compound over time and cannot be replicated by an LLM reading code:

1. **Template vocabulary** — after 30 days, Drain3 has clustered the system's log output
   into a stable vocabulary of ~200-800 templates. A new template on day 31 is genuinely
   novel. This signal-to-noise ratio is impossible on day 1.

2. **Behavioral baselines** — what "normal" looks like for each pattern, calibrated against
   actual traffic over weeks. After 90 days, baselines capture monthly cycles. Alert accuracy
   improves continuously without configuration.

3. **Longitudinal record** — "this pattern first appeared 47 days ago and has been growing
   4% per week" is a statement only persistent observation can produce.

## Consequences

### Positive

- **COGS reduction**: LLM API costs drop from $20-400/month to $0. Net savings even with
  modest ClickHouse query increase from MCP traffic.
- **Better user experience**: The user's LLM with codebase context produces dramatically
  better root cause analysis than our built-in Sonnet ever could.
- **Simpler architecture**: No LLM provider abstraction, no API key management for third-party
  LLM services, no prompt engineering maintenance.
- **Broader market**: Works with any LLM (Claude, GPT, Gemini, local models) — we're not
  locked to one provider.

### Negative

- **Dashboard loses "explain" button**: The dashboard cannot call an LLM itself. Users need
  an AI assistant (MCP, Slack bot, or browser-based) for natural language interaction.
  Mitigated: the dashboard remains valuable as a visual overview.
- **Support engineers need an intermediary**: Non-technical users cannot use MCP directly.
  Mitigated: Slack bot planned for Week 4-5.

### Requires

- Rate limiting before MCP server is published (GATE — issue #68)
- Per-tenant concurrent query limit to prevent noisy neighbours (issue #68)
- Composite API endpoints to keep MCP tool latency under 500ms (issue #66)
- Template text search via `template_registry` with skip index (issue #64)
- Cross-service template aggregation with `servicesAffected` (issue #63)
- Deploy marker API for deploy-anchored change detection (issue #69)

## References

- `docs/plans/strategy-61.md` — PRD v2 with full review synthesis
- Issue #61 — pivot tracking issue
- PLAN.md Section 10 — the LLM layer being replaced
- ADR-010 — S3 connectors for raw log drill-down (unchanged by this decision)

## Persona Validation

Scored against the status quo (CloudWatch + manual investigation):

| Persona | Score | Key insight |
|---------|-------|------------|
| SRE | 7.0/10 | "Pattern clustering alone saves 5-10 min per incident" |
| Platform eng | 6.5/10 | "I would adopt this and build on it" |
| Developer + AI | 7.0/10 | "LLM + patterns + code context is genuinely powerful" |
| Support (with AI) | 7.0/10 | "AI translates between customer language and LogWeave data" |

Average: 6.6/10 as MVP, with clear path to 8+ via deploy markers, raw log samples,
custom alert thresholds, and webhooks.
