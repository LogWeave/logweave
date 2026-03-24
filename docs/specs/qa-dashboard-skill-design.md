# QA Dashboard Skill Design Spec

**Date:** 2026-03-24
**Status:** Approved

## Goal

Enable repeatable, autonomous QA passes on the LogWeave dashboard using Chrome DevTools MCP — catching both generic UX bugs and domain-specific logic errors without manual orchestration.

## Approach

A `/qa` skill that reads per-page QA specs from `docs/qa/*.md`, health-checks the running stack, then systematically crawls each dashboard page using Chrome DevTools MCP. The agent takes screenshots, checks console/network errors, verifies expected elements and interactions from the specs, and writes a structured report.

**Key decisions:**
- Health-check first, guide if down (don't try to start services)
- QA specs are per-page markdown files in `docs/qa/` (one per route + one global)
- Agent adapts to data state (empty vs populated) rather than requiring a specific state
- Output is a timestamped markdown report in `docs/qa/reports/`
- Standalone skill (`/qa`), not a subagent

## Scope

- **In scope:**
  - `/qa` skill definition with full crawl flow
  - QA specs for all 4 pages (dashboard, alerts, tail, settings) + global cross-page checks
  - Health-check gate (dashboard + API)
  - Screenshot capture at key points
  - Console error and network failure detection
  - Domain-specific element and interaction verification from specs
  - Structured markdown report with severity classification
  - Optional single-page mode (`/qa alerts`)

- **Out of scope / deferred:**
  - Auto-creating GitHub issues from findings
  - Performance benchmarking (Lighthouse audits can be added later)
  - Mobile viewport testing
  - Visual regression / golden-file comparison
  - Starting/stopping Docker or dev servers

## Design

### 1. Skill Flow

```
/qa [page]
  │
  ├─ 1. Health-check
  │    ├─ navigate_page → localhost:5173
  │    ├─ If fails → check localhost:3000/healthz
  │    └─ If either down → report what to start, STOP
  │
  ├─ 2. Load QA specs
  │    └─ Read all docs/qa/*.md
  │
  ├─ 3. Per-page test loop (or single page if arg given)
  │    For each page (/, /alerts, /tail, /settings):
  │    ├─ navigate_page → URL
  │    ├─ wait_for → network idle / key element
  │    ├─ take_screenshot → "baseline"
  │    ├─ list_console_messages → check for errors/warnings
  │    ├─ list_network_requests → check for 4xx/5xx
  │    ├─ Verify spec assertions:
  │    │   ├─ Element presence (evaluate_script to query DOM)
  │    │   ├─ Text content checks
  │    │   └─ Data state detection (empty vs populated)
  │    ├─ Test interactions from spec:
  │    │   ├─ click → buttons, rows, toggles
  │    │   ├─ fill → inputs, selects
  │    │   └─ take_screenshot → "after interaction"
  │    └─ Collect findings with severity
  │
  ├─ 4. Cross-page checks (from docs/qa/global.md)
  │    ├─ Navigation between all pages
  │    ├─ Sidebar highlight matches current route
  │    ├─ Time range persists across navigation
  │    ├─ Color mode toggle works globally
  │    └─ Data freshness indicator present
  │
  └─ 5. Write report
       └─ docs/qa/reports/qa-report-YYYY-MM-DD[-N].md
```

### 2. QA Spec Format

Each `docs/qa/<page>.md` file uses this structure:

```markdown
# <Page Name> QA Spec — <Route>

## Page Load
- [assertion about initial render]
- [assertion about loading states]
- [assertion about empty/no-data state]

## <Component Name>
- [assertion about element presence]
- [assertion about data display]
- [assertion about visual state]

## Interactions
- [action] → [expected result]
```

Assertions are human-readable sentences. The agent interprets them and uses
`evaluate_script`, `click`, `take_screenshot`, etc. to verify. No CSS selectors
or test IDs required — the agent uses its judgment to locate elements.

### 3. Report Format

```markdown
# QA Report — YYYY-MM-DD

**Pages tested:** /, /alerts, /tail, /settings
**Data state:** populated / empty / mixed
**Duration:** ~Xm

## Summary
- CRITICAL: N
- HIGH: N
- MEDIUM: N
- LOW: N

## Findings

### [SEVERITY] Short description
- **Page:** /path
- **Component:** Component Name
- **Expected:** What should happen
- **Actual:** What actually happened
- **Screenshot:** [link or inline]
- **Console errors:** (if relevant)

---
(repeat for each finding)

## Pages with no issues
- /settings — all checks passed
```

### 4. Severity Classification

| Severity | Criteria | Examples |
|----------|----------|---------|
| CRITICAL | Page won't load, app crashes, data loss | White screen, unhandled exception, infinite spinner |
| HIGH | Wrong data displayed, broken interactions, missing error states | Incorrect metrics, click does nothing, API error not shown |
| MEDIUM | Misleading UX, missing context, confusing labels | Wrong trend color, unexplained jargon, no empty state |
| LOW | Polish, alignment, minor visual issues | Slight misalignment, truncation, icon inconsistency |

## Open Questions

None — design is straightforward.

## Test Strategy

The skill itself is the test tool. Validation:
1. Run `/qa` against a running stack with data → verify report is generated with findings
2. Run `/qa` against a stack with no data → verify empty-state checks work
3. Run `/qa alerts` → verify single-page mode works
4. Run `/qa` with API down → verify health-check gate stops and guides
