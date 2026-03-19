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

## Persona 2: Platform Engineer (first day, just connected SDK)

**Rating: 7/10**

### What works well
- "What Changed?" panel immediately demonstrates value once data flows
- Compression funnel communicates the value proposition visually
- Placeholder highlighting in detail panel makes the pattern concept click instantly
- Watch-to-Slack flow is smooth and discoverable with contextual toasts
- Template table and service health cards have good onboarding empty states
- Settings → Slack setup flow is linear and clear with URL validation
- Sidebar is clean (just Dashboard + Settings), mobile bottom tab works
- Trend sparklines in template table are information-dense but not overwhelming

### Issues found

| Priority | Issue | Detail |
|----------|-------|--------|
| **HIGH** | KPI strip has no first-run state | Six zeros with no guidance. Can't tell if integration is working or broken. |
| **MEDIUM** | Loading skeleton says "Templates", rendered says "Patterns" | `template-table.tsx` line 227 vs 244 — terminology inconsistency |
| **MEDIUM** | Tooltips reference internal architecture | "clusterer", "clusterer service logs", "log clustering engine" — user doesn't know this exists |
| **MEDIUM** | Changes panel: can't distinguish "no data" from "nothing changed" | Same message for both states |
| **MEDIUM** | Settings page: no forward-reference for watching | Mentions "watched patterns" but doesn't explain how to watch one |
| **MEDIUM** | "Spikes Active" tooltip assumes knowledge | "anomaly score above 1.0" without explaining the scale |
| **MEDIUM** | Error boundary shows component names | "KPI Strip crashed" is developer language, not user language |
| **LOW** | Compression funnel returns null on empty | Layout shifts when it disappears from the grid |
| **LOW** | "Unclustered" is jargon | "Unrecognized" or "Unmatched" would be clearer |
| **LOW** | Logo acts as sidebar toggle | Convention is for logos to navigate home |
| **LOW** | Pattern ID is displayed but not copyable | Truncated UUID with no click-to-copy affordance |

---

## Persona 3: Engineering Manager (daily health glance)

**Rating: 6/10**

### What works well
- Error rate KPI with `pp` (percentage points) suffix — correct unit for deltas
- "What Changed?" panel is the best widget — spike/new/resolved is exactly what standup needs
- Compression funnel communicates value to non-technical stakeholders
- Compare toggle on volume chart enables week-over-week visual comparison
- "Errors Only" quick filter is well-placed
- Tooltip system is thorough and jargon-free (mostly)

### Issues found

| Priority | Issue | Detail |
|----------|-------|--------|
| **MEDIUM** | Trend polarity wrong for Events/Patterns | More events = red arrow. Not inherently bad. Erodes trust within a week. |
| **MEDIUM** | No comparison period label | "↑15%" compared to what? Previous 24h? Same day last week? No label. |
| **MEDIUM** | 7D volume chart unreadable | x-axis shows HH:MM only — "14:00" repeated 7 times with no date. |
| **LOW** | No "as of" timestamp | Screenshot has no temporal anchor. When was this data from? |
| **LOW** | No summary sentence | Manager must mentally construct status from scanning widgets |
| **LOW** | Services not sorted by severity | Worst service could be buried. Should sort by error rate desc. |
| **LOW** | Changes panel: no timestamps | "When did this spike start?" requires drill-down click |
| **LOW** | Changes panel: no absolute counts for spikes | "4.2x baseline" without "(12,400 events)" hides urgency |
| **LOW** | Spikes Active KPI has no trend | Client-side computed, no previous-period comparison available |
| **LOW** | No health status labels on services | Must mentally map "2.3% err" → "fine" |

---

## Cross-Persona Synthesis

### Recurring themes (flagged by 2+ personas)

| Theme | SRE | Platform | Manager | Fix |
|-------|-----|----------|---------|-----|
| **Trend polarity** — up ≠ always bad | LOW | — | MEDIUM | Add `invertTrend` prop to KpiCard |
| **No freshness timestamp** | MEDIUM | — | LOW | Display `fetchedAt` in header |
| **Volume chart needs dates** | LOW | — | MEDIUM | Format x-axis based on range |
| **No error states** | MEDIUM | — | — | Check `isError` in each widget |
| **Tooltip jargon** ("clusterer") | — | MEDIUM | — | Rewrite from user perspective |
| **Changes panel gaps** | LOW | MEDIUM | LOW | Timestamps, counts, empty-state distinction |
| **KPI strip first-run state** | — | HIGH | — | Show guidance when all zeros |
| **Terminology inconsistency** | — | MEDIUM | — | "Templates" in loading skeleton |

### Priority ranking for fixes

**Quick wins (< 2 hours each, high impact):**
1. KPI first-run state — show onboarding guidance when data is zero
2. Trend polarity — stop showing red for neutral metric increases
3. "Updated Xs ago" in the header from `fetchedAt`
4. Volume chart dates — "Mon 14:00" when range > 24h
5. Fix "Templates" → "Patterns" in loading skeleton
6. Sort services by error rate descending
7. Changes panel: show `firstSeen` timestamp and `currentCount` on spike rows
8. Rewrite 3 tooltips that reference "clusterer"

**Medium effort (2-4 hours, high impact):**
9. Error states — check `isError` on every query hook, show inline retry
10. Deep linking — sync filters to URL search params
11. Settings page: add "how to watch a pattern" instruction
12. Error boundary: use friendly labels not component names

**Larger (4-8 hours):**
13. Summary sentence — auto-generated headline from overview + changes
14. Comparison period label on KPI trends
15. First-run onboarding flow (full welcome state when no data)

### Overall assessment
**Average rating: 6.7/10** across three personas.

The dashboard's information hierarchy is correct and the drill-down flow is strong. The "What Changed?" panel is unanimously the best widget. The main gap is **interpreted intelligence** — the raw data is there but the dashboard makes users do mental work it should do for them.

The first-run experience is the weakest point (platform engineer). A wall of zeros with no guidance is the #1 reason a new user would give up. Fixing trend polarity, adding timestamps, and adding data freshness are small changes that significantly improve trust and speed for all personas.
