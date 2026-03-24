---
name: qa
description: Autonomous QA pass on the LogWeave dashboard using Chrome DevTools MCP. Crawls pages, checks console/network errors, verifies expected behaviors from QA specs, tests interactions, and writes a structured bug report.
disable-model-invocation: false
---

Run a QA pass on the LogWeave dashboard. Optional argument: a single page name (dashboard, alerts, tail, settings) to test only that page.

Arguments: $ARGUMENTS

## Prerequisites

You MUST have access to the Chrome DevTools MCP tools (navigate_page, take_screenshot, evaluate_script, click, list_console_messages, list_network_requests, wait_for, etc.).

## Step 1: Health Check

Before testing anything, verify the stack is running:

1. Use `navigate_page` to open `http://localhost:5173`
2. If that fails, try `http://localhost:3000/healthz` to check just the API

If the dashboard is not reachable:
- Tell the user what needs to be started
- Suggest: `docker compose up -d` for ClickHouse + API, `cd services/dashboard && pnpm dev` for the dashboard
- STOP — do not proceed with testing

If the dashboard loads but API calls fail (visible in network requests), note this and continue — testing error states is valid.

## Step 2: Load QA Specs

Read all files in `docs/qa/*.md` to understand expected behaviors per page. These specs describe:
- What elements should be present on each page
- What data should look like (with and without data)
- What interactions should do
- What constitutes correct vs incorrect behavior

If no QA specs exist, you can still run a useful QA pass using general heuristics (see Step 3).

## Step 3: Test Each Page

For each page (or just the one specified in $ARGUMENTS), run through this checklist:

### 3a. Page Load

1. `navigate_page` to the page URL
2. `wait_for` network idle or a key element to appear
3. `take_screenshot` — label it as the baseline for this page
4. `list_console_messages` — flag any ERROR or WARNING level messages
5. `list_network_requests` — flag any 4xx or 5xx responses

### 3b. Spec-Based Verification

If a QA spec exists for this page, verify each assertion:
- Use `evaluate_script` to check DOM for expected elements, text content, counts
- Use `take_screenshot` to visually confirm layout and data display
- Adapt to data state: if the page shows "no data" / "waiting for data" states, verify those are correct rather than treating them as failures

### 3c. Interaction Testing

Test key interactions described in the spec (or use your judgment for common patterns):
- Click buttons and verify expected behavior (panels open, data changes, navigation occurs)
- Toggle switches and verify state changes
- Fill form inputs and verify validation
- Change filters and verify content updates
- `take_screenshot` after significant interactions

### 3d. General Heuristics (always apply, even without specs)

These are universal checks that don't need a spec:
- **No console errors** — any JS error is a finding
- **No failed network requests** — any 4xx/5xx to the API is a finding
- **No perpetual loading** — spinners/skeletons that never resolve are a finding
- **No broken layouts** — elements overflowing, overlapping, or invisible
- **Error states work** — if the API returns errors, the UI should show them (not just blank)
- **Interactive elements respond** — buttons are clickable, links navigate, inputs accept text
- **Text is readable** — no invisible text, no text clipped by containers

### Page URLs

| Page | URL | Route |
|------|-----|-------|
| Dashboard | http://localhost:5173/ | / |
| Alerts | http://localhost:5173/alerts | /alerts |
| Tail | http://localhost:5173/tail | /tail |
| Settings | http://localhost:5173/settings | /settings |

## Step 4: Cross-Page Checks

After testing individual pages, run the checks from `docs/qa/global.md`:
- Navigate between all pages using sidebar links — verify each loads
- Verify sidebar highlights the active page
- Change time range on dashboard, navigate away and back — verify it persists
- Toggle color mode (dark/light) — verify it applies globally and persists
- Check data freshness indicator in header

## Step 5: Write Report

Write findings to `docs/qa/reports/qa-report-YYYY-MM-DD.md` (if a report already exists for today, append a number: `qa-report-YYYY-MM-DD-2.md`).

Use this format:

```markdown
# QA Report — YYYY-MM-DD

**Pages tested:** [list]
**Data state:** populated / empty / mixed
**Stack status:** all services up / API down / partial

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | N |
| HIGH | N |
| MEDIUM | N |
| LOW | N |

## Findings

### [SEVERITY] Short description

- **Page:** /path
- **Component:** Component Name
- **Expected:** What should happen (from spec or heuristic)
- **Actual:** What actually happened
- **Evidence:** Screenshot reference, console error, network request
- **Reproduction:** Steps to reproduce

---

## Clean Pages

[List pages with no findings]
```

### Severity Classification

- **CRITICAL**: Page won't load, app crashes, data loss, unhandled exceptions
- **HIGH**: Wrong data displayed, broken interactions, missing error states, security issues
- **MEDIUM**: Misleading UX, missing context, confusing labels, wrong colors/polarity
- **LOW**: Polish, alignment, minor visual issues, missing tooltips

## Important Notes

- Take screenshots liberally — they are the primary evidence
- If you find a CRITICAL issue early, still continue testing other pages
- Compare what you see to the QA spec — don't just check that "something renders"
- When data is present, verify it looks reasonable (numbers not NaN, dates not epoch, etc.)
- The dashboard uses dark mode by default — test both modes if time permits
- Be thorough but practical — a QA pass should take 5-10 minutes, not 30
