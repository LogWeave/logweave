# LogWeave — Log Intelligence Platform

Log pattern extraction and anomaly detection platform. We read logs, extract templates
(via Drain3 clustering), track occurrence patterns, detect anomalies, and discard raw
content. Raw logs stay in the customer's infrastructure (S3/CloudWatch). We store only
metadata and intelligence. See @PLAN.md for full V8 architecture.

## Tech Stack

- **Clusterer**: Python 3.11+ / FastAPI / Drain3 — template extraction service
- **API Server**: Node.js / Express / TypeScript — ingestion, dashboard, query endpoints
- **Metadata Store**: ClickHouse (single-node, Docker) — ReplacingMergeTree for template registry
- **Infrastructure**: Docker Compose (3 containers: API, clusterer, ClickHouse)
- **LLM**: Claude Haiku (classification) / Sonnet (explanations) — swappable via env var
- **Alerting**: Slack webhooks
- **SDK**: `@logweave/transport` — Winston logger transport (npm, MIT)

## Directory Structure

```
services/clusterer/   — Python FastAPI clusterer (Drain3)
services/api/         — Node.js Express TypeScript API server
docs/adr/             — Architecture Decision Records
.claude/agents/       — Specialized subagents
.claude/skills/       — Repeatable workflow skills
```

## Commands

```bash
# Clusterer (once code exists)
cd services/clusterer && uv pip install -e ".[dev]" && pytest

# API Server (once code exists)
cd services/api && pnpm install && pnpm test

# Linting
cd services/clusterer && uvx ruff check . && uvx ruff format --check .
cd services/api && pnpm lint

# Typecheck API
cd services/api && pnpm typecheck

# Full stack
docker compose up --build
```

Auto-format hook runs ruff (via uvx) and biome on every file write (see .claude/hooks/auto-format.sh).

## Key Constraints — NEVER Violate

- **No raw log storage** — we store metadata and patterns only, never raw log content
- **Solo maintainer** — operational simplicity over cleverness, always
- **Docker Compose, not Kubernetes** — no exotic infrastructure
- **Two-language stack is deliberate** — Drain3 has no production Node.js equivalent
- **Clusterer is best-effort** — 500ms timeout, graceful degradation to template_id=0
- **template_registry reads use SELECT ... FINAL** — ReplacingMergeTree consistency
- **Pre-build validation is a hard gate** — Drain3 experiment must pass before infrastructure code

## Architecture Principles

- Keep code modular — clear boundaries between services, no tight coupling
- Each service should be independently testable and deployable
- Prefer small, focused modules over large files
- Shared types/contracts between services go in a shared location, not duplicated

## Prohibited Actions

- NEVER introduce a new dependency without asking first
- NEVER skip the pre-build validation gate
- NEVER store raw log content in ClickHouse or any persistent store
- NEVER add Co-Authored-By lines to commits
- NEVER modify clusterer code from an API-focused task (or vice versa) without explicit instruction
- NEVER use Kubernetes, SQS, or Kafka in MVP — defer per PLAN.md

## Feedback Loop

When corrected by the user or when a rule is violated:
1. Log the correction in @docs/lessons-learned.md with date and context
2. Update memory files to prevent recurrence in future sessions
3. If a CLAUDE.md rule was ignored, check if it needs to be rephrased or emphasized

Read @docs/lessons-learned.md at the start of each session to avoid repeating mistakes.

## Compaction Instructions

When compacting, always preserve: modified files list, current milestone, test commands,
and active ADR decisions. Reference @docs/adr/ for architectural decisions that must not
be relitigated.

## Development Workflow

Every session should follow this pattern:

1. Check `gh milestone list` and `gh issue list` to see what's active
2. For the current milestone, if issues aren't scoped yet, use `/scope-milestone` to break it down
3. **Plan first**: use `/plan` to design the approach, then have the reviewer agent critique it
4. **Execute**: work issues in dependency order using `/fix-issue` for each
5. After implementation, have the reviewer agent review the code
6. When all issues in a milestone are closed, move to the next milestone

Milestone order: Pre-Build Validation → Week 1a → Week 1b → Week 2 → Week 3 → Week 4 → Week 5

## Current Milestone

Pre-Build Validation — see GitHub Issues for active tasks.
Issue order: #2 (generate 10K log dataset) → #3 (experiment script) → #1 (run experiment) → #4 (gate review)
