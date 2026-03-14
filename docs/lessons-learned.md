# Lessons Learned

When Claude makes a repeated mistake, ignores a rule, or a correction is needed,
log it here. This file is read at the start of sessions to prevent recurrence.

Format: `### YYYY-MM-DD — Short description` followed by what happened and the fix.

---

### 2026-03-13 — Jumped to coding without entering plan mode

Started writing code immediately instead of entering plan mode. User had to correct.
Fix: Added memory rule to always enter plan mode before non-trivial implementation.

### 2026-03-13 — Committed to main before creating feature branch

First commit (CLAUDE.md + .gitignore) went directly to main before creating the
`feat/pre-build-validation` branch. Should have created the branch first.
Fix: Added branch naming convention (`LW-<issue>`) and feature branch rule to CLAUDE.md.

### 2026-03-13 — Assumed Drain3 `template_mined` was an object

Called `.get_template()` on `result["template_mined"]` but in drain3==0.9.11 it's a
plain string. Caused runtime errors in Phase 2 and Phase 8 of the experiment.
Fix: Added `get_template_text()` helper that handles both string and object returns.
Documented in `project_gotchas.md` memory file.

### 2026-03-13 — Phase 2 checkpoint test measured the wrong thing

Original test re-clustered the same 5K messages after restart and compared template
texts. This fails because Drain3 legitimately generalizes templates better on the
second pass (the checkpoint gives it a richer model). The correct test: train on 5K,
checkpoint, then compare templates for *unseen* messages between continued and restored
miners. Fix: Rewrote Phase 2 to test unseen messages.

### 2026-03-14 — Rename broke test file silently, survived multiple review rounds

Commit `d5da3be` renamed `TenantLimitExceeded` → `TenantLimitError` in drain_service.py
but did not update test_drain_service.py. The broken import caused pytest to skip the
entire file (18 tests) with a collection error — but the suite still reported "74 passed"
with no indication that a critical module was absent. This survived 2 rounds of adversarial
review because reviewers read the code but never ran the tests.

Root causes:
1. The rename was bundled in a lint/chore commit — reviewers skimmed it
2. No reviewer actually executed `uv run poe test` and checked output
3. No baseline test count to detect the drop from ~92 to 74

Fixes applied:
- Added `strict_markers = true` and `filterwarnings` to pytest config
- Added "Post-Commit Verification" rules to CLAUDE.md (always check test count)
- Added "Renames get their own commit" rule to CLAUDE.md
- Added verification requirement to reviewer.md (must run tests, not just read code)
- Added Multi-Agent Review Protocol to CLAUDE.md (verify findings before reporting)

### 2026-03-14 — Reviewer used as implementation safety net, not a design reviewer

During issue #13, the reviewer caught: non-root Dockerfile, pnpm@latest non-deterministic,
x-powered-by not disabled, no unhandledRejection handler, JSON parse errors returning 500,
`allowUnreachableCode: true` (set backwards — allows dead code instead of erroring),
magic number status codes, @types/node missing, dist/ not excluded from Biome.

These are all basic production hygiene — none require a reviewer to catch. They should be
right on the first commit. The reviewer should be reserved for subtle design issues,
contract violations, and edge cases.

Root cause: No mental checklist for "production-ready Express service" before committing.

Fix: Before committing any new Express service/route, verify:
- Dockerfile: non-root USER, pinned pnpm version, dist copied not src
- app.ts: `app.disable('x-powered-by')`
- index.ts: `unhandledRejection` handler
- error-handler: body-parser errors (statusCode < 500) return 4xx not 500
- No magic HTTP status numbers — always use named constants
- `@types/node` in devDependencies when using node: built-ins
- `dist/` excluded from linter config
- tsconfig: no `allowUnreachableCode: true` (that ALLOWS dead code, wrong direction)
- Run reviewer in background, not foreground

### 2026-03-14 — Reviewer ran in foreground, blocking the entire session

Ran the first reviewer agent synchronously (foreground), blocking all work for ~11 minutes.
User had to ask why nothing was happening. The tsconfig reviewer was then correctly launched
in background but was redundant — its recommendations were already applied while it ran.

Fix: Reviewer agents always run in background (`run_in_background: true`) unless their
output is needed before the next step can proceed (rare). Check if background results
are already applied before acting on them.

### 2026-03-14 — Compound Bash commands instead of dedicated tools

Repeatedly used Bash for things that dedicated tools handle better:
- `cat file` instead of Read tool
- `grep pattern` instead of Grep tool
- `ls` / `find` instead of Glob tool
- Long `&&`-chained commands that appear as one giant approval prompt

The dedicated tools are transparent, reviewable, and purpose-built. Bash should be
reserved for commands that genuinely need a shell: pnpm, git, docker, system operations.
Independent Bash calls should be parallel tool calls, not `&&` chains.

Fix: Default to Read/Grep/Glob/Edit/Write. Only use Bash for shell-required operations.
When multiple independent Bash calls are needed, issue them as parallel tool calls.

### 2026-03-14 — Trusted empty gh milestone query without fallback

`gh issue list --milestone "Week 1b"` returned empty because the full milestone title is
`Week 1b — API Server + Transport` and `--milestone` requires an exact match. Instead of
falling back to `gh issue list` (no filter) to see what actually exists, I declared there
were no issues and proposed re-scoping — wasting the user's time and contradicting what
they could plainly see.
Fix: When a filtered query returns empty, always verify with an unfiltered query before
concluding data doesn't exist. Don't trust absence of results as absence of data.

### 2026-03-14 — ClickHouse TTL requires DateTime, not DateTime64

Used `TTL timestamp + toIntervalDay(30) DELETE` where `timestamp` is `DateTime64(3)`.
ClickHouse rejects this: TTL expressions must evaluate to `DateTime` or `Date`, not
`DateTime64`. Fix: wrap with `toDateTime()`: `TTL toDateTime(timestamp) + toIntervalDay(30)`.

### 2026-03-14 — ClickHouse default JSON format returns { data: T[] } not T[]

`@clickhouse/client`'s default `JSON` format returns `{ data: T[], meta: [...], ... }`,
not `T[]`. Casting `result.json() as T[]` compiles but returns wrong type at runtime.
Fix: use `JSONEachRow` format which returns `T[]` directly, or extract `.data` from
the JSON wrapper.

### 2026-03-14 — Docker ClickHouse default user is XML-readonly

`ALTER USER default SETTINGS ...` fails on Docker ClickHouse because the default user
is defined in XML config (readonly storage). The guardrails must be best-effort (catch
and log, don't crash). For production, use per-query `clickhouse_settings` instead.
