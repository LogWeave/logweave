# Week 2 Postmortem — Dashboard + Slack

**Date:** 2026-03-18
**Method:** BMAD-style multi-agent review (5 agents: SRE pre-mortem, new-user UX audit, product inversion, UX red team, architecture review)

---

## Critical Bugs (fix before anything else)

| # | Bug | Location | Impact |
|---|-----|----------|--------|
| 1 | **AnomalyScorer baseline key uses `:` but lookup uses `\0`** — baselines from ClickHouse never match, scoring silently broken in production | `anomaly-scorer.ts:249` | Anomaly scoring for established patterns is dead. All alerts degrade to new-template-only mode |
| 2 | **Watches API returns `string[]` but dashboard expects `{ templateId }[]`** — `w.templateId` is always `undefined`, bells never show, watched filter broken | API: `watches.ts:65`, Dashboard: `template-table.tsx:42` | Entire watch UI is non-functional |
| 3 | **Refresh button has no onClick handler** — dead UI element | `header.tsx:49` | Users click refresh, nothing happens |

---

## Synthesized Priority List

Cross-referenced across all 5 agents. Items that multiple agents flagged independently are marked with the agent count.

### MUST HAVE — Ship cannot launch without these

| # | Item | Agents who flagged | Effort |
|---|------|--------------------|--------|
| 1 | **Fix the 3 critical bugs above** | Architecture | Small |
| 2 | **Deep-link from alerts/changes to raw logs** — "View in source" button that opens a pre-filtered query in customer's log store (CloudWatch/S3/etc) | Maya (SRE), Product Owner | Medium |
| 3 | **Empty-state onboarding flow** — when no data: show setup wizard (install SDK, send logs, configure Slack) | Kai (new user), Product Owner | Medium |
| 4 | **Persist watches + settings to ClickHouse** — in-memory stores reset on deploy, silently loses all user config | Maya, Product Owner, Architecture (3/5) | Medium |
| 5 | **Make "What Changed?" items clickable** — spike/new/resolved should open the template detail panel | Kai, UX Architect (2/5) | Small |
| 6 | **Explain the "patterns not raw logs" concept** — first-time users look for log search and think it's broken | Kai, Product Owner (2/5) | Small |
| 7 | **Slack daily summary** — PLAN.md's "primary retention mechanism," currently unbuilt | Product Owner | Medium |
| 8 | **URL-shareable filter state** — team collaboration requires sharable links | Maya, UX Architect (2/5) | Medium |

### SHOULD HAVE — Significant pain, workarounds exist

| # | Item | Agents | Effort |
|---|------|--------|--------|
| 9 | **"Spikes Active" KPI in the strip** — product's core value has zero top-level visibility | UX Architect | Small |
| 10 | **KPI trend arrows** — all 5 KPIs show static numbers, no delta vs previous period (trend prop exists but never used) | UX Architect | Medium |
| 11 | **Move "What Changed?" above the volume chart** — it's the most actionable widget but buried below fold | UX Architect | Small |
| 12 | **Custom time range picker** — only 1H/6H/24H/7D presets, can't zoom to deploy window | Maya, UX Architect (2/5) | Medium |
| 13 | **Consistent terminology** — UI mixes "patterns" and "templates" | Kai | Small |
| 14 | **Alerting config: thresholds, routing, channels** — current watch is binary on/off with no config | Maya | Large |
| 15 | **CORS middleware for dev** — dashboard can't call API cross-origin during development | Architecture | Small |
| 16 | **Tests for settings routes + SlackObserver** — zero test coverage on delivery pipeline | Architecture | Medium |
| 17 | **Alert-to-dashboard deep link** — `?template=<id>` in Slack link doesn't auto-select on dashboard | Product Owner | Small |
| 18 | **Remove/replace disabled nav items** — "Patterns" and "Alerts" greyed out signals half-built product | Kai, Product Owner, UX Architect (3/5) | Small |
| 19 | **Human-readable anomaly labels** — "0.42" means nothing, show "Normal" / "Elevated" / "Anomalous" | Kai, Product Owner (2/5) | Small |
| 20 | **Surface auth/connection errors in UI** — bad API key shows infinite loading, no error message | Product Owner | Small |

### NICE TO HAVE — Polish and competitive edge

| # | Item | Agents | Effort |
|---|------|--------|--------|
| 21 | **"Explain this error" button (Week 3 LLM feature)** | Product Owner | Large |
| 22 | **Compression funnel to sidebar/KPI** — takes prime row-1 space, low daily value | UX Architect | Small |
| 23 | **Saved views / bookmarks** | Maya, UX Architect (2/5) | Large |
| 24 | **Deploy markers on volume chart** | Maya, Product Owner (2/5) | Medium |
| 25 | **Cost savings calculator in dashboard** | Product Owner | Medium |
| 26 | **Multi-environment support** (staging vs prod) | Maya | Large |
| 27 | **"Last updated" indicator in header** | UX Architect | Small |
| 28 | **Keyboard shortcuts** (E for errors-only, / for search) | Maya | Small |
| 29 | **Service card click affordance** — no visual hint they're filterable | Kai | Small |
| 30 | **Split dashboard.ts route file** (458 lines) | Architecture | Medium |

---

## Tech Debt to Address

| Item | Severity | Location |
|------|----------|----------|
| Dead code: `queryLogMetadata`, `queryTemplateStats`, `queryServiceStats` unused | Medium | `db/queries.ts` |
| `sort` param validated but never used in templates query | Low | `dashboard-types.ts:45` |
| CSP disabled with no plan to re-enable | Medium | `app.ts:44` |
| Dashboard types duplicated between API and dashboard | Medium | Both `types.ts` files |
| `hiddenTemplateIds` is array with O(n) `.includes()` per row | Low | `dashboard-store.ts` |
| `pre_processed_message` retained for unclustered rows (contradicts "no raw storage" constraint) | Medium | `ingest.ts:76` |
| SlackObserver delivery/rate-limit maps never pruned | Low | `slack-observer.ts:38,41` |
| `SELECT *` in `LOG_METADATA_BY_TENANT_QUERY` could leak content | Medium | `queries.ts:60` |
| No dashboard tests (0 test files in services/dashboard/) | Medium | — |

---

## What's Working Well (don't break these)

All 5 agents independently praised:
1. **"What Changed?" panel** — the right question, well-executed
2. **Compression funnel** — unique value prop visualization
3. **Template detail panel** — rich, well-organized, status codes, sparklines
4. **Level filter with "Errors Only" shortcut** — fast noise reduction
5. **Dark mode default + design token system** — professional, SRE-friendly
6. **Error boundaries + skeleton loading** — polished loading states
7. **Observer pattern for alerts** — clean extensibility

---

## What Would Kill This Product (Product Owner's top 3)

1. **No onboarding + silent auth failures = 0% self-setup success**
2. **No daily summary = invisible product on quiet days**
3. **In-memory persistence = silent data loss on every deploy**

## What Would Make It Succeed (Product Owner's top 3)

1. **Pattern intelligence is genuinely differentiated** — nothing like it at $79/mo
2. **Architecture is honestly solo-maintainable** — Docker Compose, 2 containers, clear boundaries
3. **Cost story is a compounding wedge** — Model B lands cheap, Model C saves $15k/yr

---

## Recommended Week 3 Focus

**Phase 1 (before new features):** Fix bugs #1-3, persist stores, add CORS, wire refresh button, make changes clickable. ~1 day of work.

**Phase 2 (Week 3 features):** "Explain this error" LLM button, deep-link to raw logs, daily Slack summary, URL-shareable state, "Spikes Active" KPI. These are the features that convert trialists to paying customers.

**Phase 3 (polish):** Onboarding empty states, terminology consistency, KPI trends, custom time ranges, nav item cleanup.
