# LogWeave — Log Intelligence Platform

Log pattern extraction and anomaly detection platform. We read logs, extract templates
(via Drain3 clustering), track occurrence patterns, detect anomalies, and discard raw
content. Raw logs stay in the customer's infrastructure (S3/CloudWatch). We store only
metadata and intelligence. See PLAN.md for full V8 architecture (load on demand, not auto-loaded).

## Tech Stack

- **Clusterer**: Python 3.11+ / FastAPI / Drain3 — template extraction service
- **API Server**: Node.js / Express / TypeScript — ingestion, dashboard, query endpoints
- **Metadata Store**: ClickHouse (single-node, Docker) — ReplacingMergeTree for template registry
- **Infrastructure**: Docker Compose (3 containers: API, clusterer, ClickHouse)
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
# Clusterer (from services/clusterer/)
uv sync --dev            # install deps
uv run poe test          # run tests
uv run poe check         # lint + format check
uv run poe lint          # lint only
uv run poe format        # auto-format
uv run poe serve         # dev server with hot reload

# API Server (from services/api/, once code exists)
pnpm install             # install deps
pnpm test                # run tests
pnpm lint                # lint + format check
pnpm typecheck           # typecheck

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
- NEVER claim a test failure is "pre-existing" or "known" — every failing test is either fixed or removed. There is no middle ground.
- NEVER declare work complete without running the test suite and seeing all tests pass

## Verification Before Completion

Before declaring any task complete, you MUST have **fresh evidence** that it works:

1. **Run the test suite** for every modified service — see actual PASS output, not memory of a prior run
2. **No weasel words** — if you catch yourself saying "should work", "probably fine", "seems correct",
   or expressing satisfaction before running verification, STOP and run the actual commands
3. **Test failures are binary** — a failing test is either fixed (because it caught a real bug) or
   removed (because it's no longer relevant). "Pre-existing failure" is not a valid status.
4. **Verification means running commands** — reading code is not verification. Seeing green test output is.

The stop-gate hook (.claude/hooks/stop-gate.sh) enforces this: if tests fail, you cannot finish.

## Brainstorming Workflow

For any non-trivial creative work (new features, architecture changes, behavior modifications):
1. Use `/brainstorm <topic>` BEFORE planning or coding
2. This runs a structured Socratic questioning process to surface edge cases and design decisions
3. The output is a design spec committed to `docs/specs/`
4. Only after the spec is approved should you proceed to planning or implementation

## Feedback Loop

When corrected by the user or when a rule is violated:
1. Log the correction in docs/lessons-learned.md with date and context
2. Update memory files to prevent recurrence in future sessions
3. If a CLAUDE.md rule was ignored, check if it needs to be rephrased or emphasized

Read docs/lessons-learned.md at the start of each session to avoid repeating mistakes.

## Compaction Instructions

When compacting, always preserve: modified files list, current milestone, test commands,
and active ADR decisions. Reference docs/adr/ for architectural decisions that must not
be relitigated.

## Development Workflow

Every session should follow this pattern:

1. Check `gh milestone list` and `gh issue list` to see what's active
2. For the current milestone, if issues aren't scoped yet, use `/scope-milestone` to break it down
3. **Plan first**: use `/plan` to design the approach, then have the reviewer agent critique the plan
4. **Execute**: work issues in dependency order using `/fix-issue` for each
5. After implementation, have the reviewer agent review the code
6. When all issues in a milestone are closed, move to the next milestone

## Multi-Agent Review Protocol

When running multi-agent reviews (postmortems, PR reviews, plan reviews):

1. **Every MUST FIX finding must be verified** — read the actual code at the cited line, run tests if claiming breakage. Do not report unverified findings as confirmed.
2. **Cross-reference between agents** — if only one agent flags something, verify harder before escalating.
3. **Run the test suite** before synthesizing — confirms any "tests are broken" claims.
4. **Plans get reviewed too** — before implementing a plan, have the reviewer agent critique it against PLAN.md, ADRs, and constraints. Plans should be challenged, not rubber-stamped.
5. **Classify findings honestly** — MUST FIX is for confirmed bugs/security issues only. Style preferences go in TRACK or REJECTED.

**Always work in feature branches** — never commit directly to main, even for solo work. Merge locally when done.
**Branch naming: `LW-<issue-number>`** (e.g., `LW-5`, `LW-12`). For multi-issue work, use the primary issue number.
**Commit frequently** — after each logical unit of work. Keeps context lean and mistakes easy to undo.

Milestone order: Pre-Build Validation → Week 1a → Week 1b → Week 2 → Week 3 (LLM-Ready Pivot) → Week 4 → Week 5 → Week 6

## Architecture Reference

PLAN.md contains the full V8 architecture plan. It is large — do NOT read it automatically.
Read it with the Read tool only when you need architectural context (API contracts,
data model, roadmap items, pricing, etc.). For quick reference, the key sections are:
- Section 6: Architecture (service contracts, env vars)
- Section 7: Data Model (ClickHouse schema)
- Section 9: Metadata Extraction (pipeline, pre-processing)
- Section 15: Build Roadmap (milestone details)

## Product Direction

LogWeave is the **log intelligence layer that external AI agents query** — not an AI-powered tool itself.
Users connect their own LLMs (which already know their codebase) to our API/MCP surface. We provide
structured runtime intelligence (patterns, trends, anomalies). No built-in LLM features.

## Current Milestone

Week 3 — LLM-Ready Pivot (#61). Design the API/MCP surface as the primary product.
Use `/strategist` to develop product strategy, then `/scope-milestone` to break into issues.
Check `gh issue list -m "Week 3 — LLM-Ready Pivot"` for active tasks.
