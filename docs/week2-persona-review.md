# Week 2 Persona Review — Dashboard UX Evaluation

**Date:** 2026-03-19
**Method:** Code-based review (agents read all dashboard components and evaluated user journeys)

---

## Persona 1: SRE On-Call (3am incident response)

**Rating: 7/10**

### What works well
- KPI strip → Changes panel → Detail panel is 1-2 clicks from "alert fired" to "I understand the problem"
- "Spikes Active" KPI with red/amber variants gives immediate severity signal
- Anomaly score shows human-readable labels (Normal/Elevated/Anomalous)
- Service health cards as global filters — click a service, everything scopes down
- "Errors Only" button — one click to focus
- Compare toggle on volume chart answers "is this normal for this time of day?"
- Watch → Slack flow is discoverable from the detail panel
- Error boundaries per widget prevent cascading failures
- Keyboard support (Escape closes panel, table row navigation)

### Issues found

| Priority | Issue | Detail |
|----------|-------|--------|
| **MEDIUM** | No data freshness indicator | `fetchedAt` in API responses but never displayed. Stale data looks like live data. |
| **MEDIUM** | No error state rendering | API down → zeros everywhere, looks like "no traffic" not "API unreachable" |
| **MEDIUM** | No deep linking / URL state | Can't share investigation context via URL with colleagues |
| **LOW** | Default time range 24h | SRE wants 1h during incident. Persists in localStorage but defaults to 24h. |
| **LOW** | Trend arrows: red-up for ALL metrics | Events going up ≠ bad. Red should be reserved for error-oriented metrics. |
| **LOW** | Volume chart: no dates on x-axis | HH:MM only. 24h/7d views are ambiguous without dates. |
| **LOW** | Changes panel: no severity ordering | Events render in API order. Spikes could be buried under resolved events. |
| **LOW** | Sparklines only for first 20 templates | Low-volume spiking template could rank below position 20. |

---

## Persona 2: Platform Engineer (first day)

**Rating: Not completed** (reviewer stalled)

To be evaluated in next session via Chrome DevTools MCP against live dashboard.

---

## Persona 3: Engineering Manager (daily health glance)

**Rating: 6/10**

### What works well
- Error rate KPI with `pp` (percentage points) suffix — correct unit for deltas
- "What Changed?" panel is the best widget — spike/new/resolved is exactly what standup needs
- Compression funnel communicates value to non-technical stakeholders
- Compare toggle on volume chart enables week-over-week visual comparison
- "Errors Only" quick filter is well-placed
- Tooltip system is thorough and jargon-free

### Issues found

| Priority | Issue | Detail |
|----------|-------|--------|
| **MEDIUM** | Trend polarity wrong for Events/Patterns | More events = red arrow. Not inherently bad. Erodes trust within a week. |
| **MEDIUM** | No comparison period label | "↑15%" compared to what? Previous 24h? Same day last week? No label on the trend. |
| **MEDIUM** | 7D volume chart unreadable | x-axis shows HH:MM only — "14:00" repeated 7 times with no date. |
| **LOW** | No "as of" timestamp | Screenshot has no temporal anchor. When was this data from? |
| **LOW** | No summary sentence | Manager must mentally construct "2 spikes, 1 degraded service" from scanning widgets |
| **LOW** | Services not sorted by severity | Worst service could be buried. Should sort by error rate desc. |
| **LOW** | Changes panel: no timestamps | "When did this spike start?" requires drill-down click |
| **LOW** | Changes panel: no absolute counts for spikes | "4.2x baseline" without "(12,400 events)" hides whether it's urgent or minor |
| **LOW** | Spikes Active KPI has no trend | Client-side computed, no previous-period comparison available |
| **LOW** | No health status labels on services | Must mentally map "2.3% err" → "fine" and "7.1% err" → "not fine" |

---

## Cross-Persona Synthesis

### Recurring themes (flagged by multiple personas)

| Theme | SRE | Manager | Fix complexity |
|-------|-----|---------|---------------|
| **Trend polarity** — up ≠ always bad | LOW | MEDIUM | Small — add `trendPolarity` prop to KpiCard |
| **No freshness timestamp** | MEDIUM | LOW | Small — display `fetchedAt` in header |
| **Volume chart needs dates** | LOW | MEDIUM | Small — format x-axis based on time range |
| **No error states for failed queries** | MEDIUM | — | Medium — check `isError` in each widget |
| **Changes panel needs timestamps + counts** | — | LOW | Small — render `firstSeen` and `currentCount` |

### Priority ranking for fixes

**Quick wins (< 2 hours each, high impact):**
1. Trend polarity — add `invertTrend` prop to KpiCard, apply to Events and Patterns
2. Data freshness — show "Updated Xs ago" in header from `fetchedAt`
3. Volume chart dates — format as "Mon 14:00" when range > 24h
4. Sort services by error rate descending
5. Changes panel: show `firstSeen` timestamp and `currentCount` on spike rows

**Medium effort (2-4 hours, high impact):**
6. Error states — check `isError` on every query hook, show inline retry prompt
7. Deep linking — sync filters to URL search params via `useSearchParams`

**Larger (4-8 hours):**
8. Summary sentence — auto-generated headline from overview + changes data
9. Comparison period label on KPI trends

### Overall assessment
The dashboard's information hierarchy is correct and the drill-down flow is strong. The main gap is **interpreted intelligence** — the raw data is there but the dashboard makes users do mental work that it should do for them. Fixing trend polarity, adding timestamps, and sorting by severity are small changes that would significantly improve trust and speed.
