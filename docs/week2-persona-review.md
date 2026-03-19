# Week 2 Persona Review — Dashboard UX Evaluation

**Date:** 2026-03-19
**Methods:**
- Code-based review (3 agents reading all dashboard components)
- Live UI evaluation via Chrome DevTools MCP against running dashboard with simulator

---

## Live UI Findings (MCP session — with real data + simulator)

### CRITICAL: Dashboard unresponsive under sustained simulator load

The simulator causes continuous re-renders that make the dashboard unresponsive — buttons not clickable, JS evaluation timing out, navigation failing. This blocks all persona workflows.

**This is the #1 issue.** Everything else is secondary.

---

## Persona 1: SRE On-Call (3am incident response)

| Source | Rating |
|--------|--------|
| Code review | 7/10 |
| Live MCP | 6/10 |

### Confirmed by both reviews
- KPI strip → Changes panel is 1-2 clicks to context (best flow)
- "What Changed?" panel is the killer feature — sorted by spike magnitude
- Level filter buttons + time range selector work well
- Volume chart with per-service stacking immediately shows blast radius

### New findings from live MCP (not caught by code review)
- **Clicking pattern rows failed** — continuous re-render prevents interaction
- **Error column shows 0 for all patterns** — 5% error rate with 2,787 ERROR events, but table shows 0 errors per pattern. Data mapping bug?
- **No severity gradient on spike badges** — 257x and 6x spikes look identical (same orange)
- **No acknowledge/snooze on spikes** — 33 spikes, many are variants, no way to batch-dismiss

### Confirmed from code review
- No data freshness indicator (MEDIUM)
- No error states when API is down (MEDIUM)
- No deep linking for sharing context (MEDIUM)
- Trend polarity wrong — red-up for all metrics (LOW)

---

## Persona 2: Platform Engineer (first day)

| Source | Rating |
|--------|--------|
| Code review | 7/10 |
| Live MCP | 5/10 |

### Confirmed by both reviews
- Compression funnel is brilliant — "1303:1 ratio" communicates value instantly
- Tooltips on KPI cards are helpful and well-written
- Simple navigation (Dashboard + Settings only)

### New findings from live MCP
- **`<*>` placeholder syntax is unexplained** — `User <*> authenticated via <*> from <IP>` looks like broken HTML. No legend or tooltip on what `<*>`, `<IP>`, `<UUID>` mean in the table view (detail panel has tooltips but table doesn't)
- **"Hide pattern" purpose unclear** — no tooltip explaining what hiding does or whether it affects alerting
- **"Compare" button has no label** — compare to what?
- **"What Changed?" lacks time context** — changed vs what baseline?
- **With only 2 hours of data, trend percentages are misleading** — ↓62.8% when you've only had one window

### Confirmed from code review
- KPI strip has no first-run state — wall of zeros (HIGH)
- Loading skeleton says "Templates" not "Patterns" (MEDIUM)
- Tooltip jargon: "clusterer", "clusterer service logs" (MEDIUM)
- Settings page mentions "watched patterns" but doesn't explain how (MEDIUM)

---

## Persona 3: Engineering Manager (daily health glance)

| Source | Rating |
|--------|--------|
| Code review | 6/10 |
| Live MCP | 5/10 |

### Confirmed by both reviews
- Trend percentages on KPI cards give instant direction
- Service cards enable quick cross-service comparison
- No comparison period label — "↑286%" vs what?
- 7D volume chart x-axis is unreadable (HH:MM only, no dates)

### New findings from live MCP
- **NEW TODAY ↓100% shown in red** — 0 new patterns is GOOD news, not bad. Red arrow is wrong. This is the trend polarity bug but confirmed as actively misleading with real data
- **No exportable summary** — can't copy a status update for Slack standup
- **Service cards have no sparkline trends** — static "7.2% err" with no direction
- **Pattern table shows raw counts not percentages** — manager needs "10% of traffic" not "5,456"

### Confirmed from code review
- Trend polarity wrong (MEDIUM — now confirmed as a real bug with live data)
- No "as of" timestamp for screenshots (LOW)
- Services not sorted by severity (LOW)

---

## Cross-Reference: All Unique Issues

### CRITICAL (blocks usage)

| # | Issue | Source | Detail |
|---|-------|--------|--------|
| 1 | **Dashboard unresponsive under load** | MCP | Simulator causes re-render storms. Buttons unclickable, JS timeouts. |

### HIGH (data correctness / first-run)

| # | Issue | Source | Detail |
|---|-------|--------|--------|
| 2 | **KPI first-run state** | Code | Six zeros with no guidance on fresh install |
| 3 | **Error column shows 0 for all patterns** | MCP | 5% error rate but 0 errors per row — data mapping bug? |
| 4 | **Trend polarity: NEW TODAY ↓100% in red** | Both | 0 new patterns = good, but shows scary red. Events/Patterns up = red when it shouldn't be |

### MEDIUM (misleading or confusing)

| # | Issue | Source | Detail |
|---|-------|--------|--------|
| 5 | No data freshness indicator | Code | `fetchedAt` exists but never displayed |
| 6 | No error states when API down | Code | Shows zeros, not "failed to load" |
| 7 | No deep linking / URL state | Code | Can't share investigation via URL |
| 8 | No comparison period label | Both | "↑15%" — vs what? Previous 24h? Last week? |
| 9 | `<*>` placeholders unexplained in table | MCP | Looks like broken HTML to new users |
| 10 | "What Changed?" lacks time context | MCP | Changed vs what baseline? |
| 11 | No severity gradient on spike badges | MCP | 257x and 6x look identical |
| 12 | Tooltip jargon ("clusterer") | Code | 3 tooltips reference internal architecture |
| 13 | Loading skeleton says "Templates" | Code | Should say "Patterns" |
| 14 | Settings: no forward-reference for watching | Code | Mentions "watched patterns" without explaining how |
| 15 | Changes panel: no data vs nothing changed | Code | Same message for both states |
| 16 | Error boundary shows component names | Code | "KPI Strip crashed" is dev language |

### LOW (polish)

| # | Issue | Source | Detail |
|---|-------|--------|--------|
| 17 | Volume chart: no dates on x-axis | Both | HH:MM only, 7D view unreadable |
| 18 | Services not sorted by severity | Code | Worst service could be buried |
| 19 | Changes panel: no timestamps or counts | Both | No "when" or "how many" on spike rows |
| 20 | Spikes Active KPI has no trend arrow | Both | Only KPI without direction indicator |
| 21 | "Hide pattern" unexplained | MCP | No tooltip on what hiding does |
| 22 | "Compare" button unlabeled | MCP | Compare to what? |
| 23 | No acknowledge/snooze on spikes | MCP | Can't batch-dismiss known spikes |
| 24 | Service cards: no sparkline trends | MCP | Static number, no direction |
| 25 | Header filter counts update live | MCP | Numbers keep changing, hard to read |
| 26 | Pattern ID not copyable | Code | Truncated UUID with no click-to-copy |
| 27 | Logo acts as sidebar toggle | Code | Convention is for logos to navigate home |
| 28 | Compression funnel disappears on empty | Code | Layout gap when no data |

---

## Priority Plan

### Must fix before Week 3

1. **Dashboard performance under load** — debounce re-renders, throttle polling, investigate what the simulator triggers
2. **Trend polarity** — add `invertTrend` prop. Events/Patterns/New Today: up = neutral. Error Rate/Unclustered/Spikes: up = bad
3. **Error column data mapping** — investigate why errors show 0 when error rate is 5%

### Should fix (quick wins, < 2 hours each)

4. "Updated Xs ago" in header
5. Volume chart: date labels when range > 24h
6. Fix "Templates" → "Patterns" in loading skeleton
7. Sort services by error rate desc
8. Changes panel: add `firstSeen` timestamp and `currentCount`
9. Rewrite 3 "clusterer" tooltips
10. Add comparison period label to trend arrows (e.g., "vs prev 24h")

### Should fix (medium effort, 2-4 hours)

11. Error states on all query hooks
12. Deep linking via URL search params
13. `<*>` placeholder legend in template table
14. Spike badge severity gradient (color intensity by ratio)

### Future (nice to have)

15. Summary sentence at top
16. First-run onboarding flow
17. Export/copy summary for Slack
18. Acknowledge/snooze spikes

---

## What Works Really Well (keep these)

Both reviews unanimously praised:
- **KPI strip layout** — 6 cards, clean hierarchy, trend arrows, color-coded
- **Compression funnel** — "1303:1" is a wow moment, communicates value instantly
- **"What Changed?" panel** — sorted by magnitude with service attribution
- **Volume chart** — stacked area by service, compare mode
- **Tooltips** — well-written, mostly jargon-free
- **Overall visual design** — dark theme is clean, information hierarchy is clear
- **Watch → Slack flow** — discoverable, contextual toast messages
