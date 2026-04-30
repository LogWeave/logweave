# Log Cost Optimizer Design Spec

**Date:** 2026-03-26
**Status:** Approved

## Goal

Surface noisy, low-value log patterns with volume impact so teams (and their LLM agents) can identify
where to reduce logging costs — without LogWeave needing to know the customer's pricing model.

## Approach

Count-based pattern analysis using existing `template_stats` data. Classify each template into
noise/review/keep buckets with configurable per-tenant thresholds. Soft suggestions guide action
without being prescriptive. Surface via API endpoint, MCP tool, and dashboard widget.

## Scope

**In scope:**
- REST endpoint `GET /v1/cost/analysis` with `since` and `service` params
- MCP tool `cost_optimizer` consuming the same endpoint
- Dashboard widget showing noise/review patterns with threshold configuration
- Per-tenant configurable thresholds (stored in TenantSettingsStore)
- Classification logic: noise, review, keep — with human-readable suggestions
- README update listing Log Cost Optimizer as a feature

**Out of scope / deferred:**
- Dollar cost estimates (requires platform pricing knowledge we don't have)
- Byte-level size estimation (counts are sufficient for ranking)
- "Apply recommendation" actions (requires customer logging config integration)
- Historical trend of noise patterns over time (future enhancement)
- Platform presets (CloudWatch/Datadog/Splunk pricing tables)

## Design

### 1. Configurable Thresholds

Stored in `TenantSettingsStore` (ClickHouse-backed), with defaults:

```typescript
interface CostOptimizerThresholds {
  noise_debug_pct: number;    // DEBUG/TRACE above this % of service volume → noise (default: 5)
  review_info_pct: number;    // INFO above this % of service volume → review (default: 10)
  review_warn_pct: number;    // WARN above this % of service volume → review (default: 20)
}
```

Thresholds are per-tenant. Unset = defaults. Dashboard settings UI exposes these as adjustable values.

### 2. Classification Logic

For each template within the requested time window, compute:
- `count`: total occurrences
- `volume_pct`: count / total service count × 100

Then classify:

| Bucket     | Criteria                                           | Suggestion                                                                |
|------------|----------------------------------------------------|---------------------------------------------------------------------------|
| **noise**  | DEBUG or TRACE level AND volume_pct > noise_debug_pct | "Consider removing — debug logging in production, X% of service volume"   |
| **review** | INFO level AND volume_pct > review_info_pct        | "Consider sampling — high volume, verify if every occurrence is needed"    |
| **review** | WARN level AND volume_pct > review_warn_pct        | "Consider sampling — high-volume warnings, check if actionable"           |
| **keep**   | ERROR/FATAL at any volume, or below thresholds     | null (no action suggested)                                                |

### 3. Query

Aggregate `template_stats` over the requested window, grouped by template_id + service.
Join to `template_registry FINAL` for template string and level.
Compute volume_pct per service. Apply classification rules using tenant thresholds.

```sql
-- Pseudocode: actual query built in TypeScript
SELECT
  ts.template_id,
  tr.template,
  ts.service,
  tr.level,
  sum(ts.occurrence_count) AS count,
  count / sum(count) OVER (PARTITION BY ts.service) * 100 AS volume_pct
FROM template_stats ts
JOIN template_registry FINAL tr ON ts.template_id = tr.template_id AND ts.tenant_id = tr.tenant_id
WHERE ts.tenant_id = {tenant_id}
  AND ts.bucket >= {since_timestamp}
  AND ({service} IS NULL OR ts.service = {service})
GROUP BY ts.template_id, tr.template, ts.service, tr.level
ORDER BY count DESC
```

### 4. REST Endpoint

```
GET /v1/cost/analysis?since=24h&service=api-gateway
```

Response:
```json
{
  "summary": {
    "window": "24h",
    "total_patterns": 142,
    "noise_patterns": 8,
    "review_patterns": 15,
    "potential_reduction_pct": 34.2
  },
  "patterns": [
    {
      "template_id": "01957...",
      "template": "Health check responded in <*> ms",
      "service": "api-gateway",
      "level": "DEBUG",
      "count": 847201,
      "volume_pct": 62.3,
      "classification": "noise",
      "suggestion": "Consider removing — debug logging in production, 62.3% of api-gateway volume"
    }
  ],
  "thresholds": {
    "noise_debug_pct": 5,
    "review_info_pct": 10,
    "review_warn_pct": 20
  }
}
```

Only `noise` and `review` patterns are returned (sorted by count descending). `keep` patterns are excluded
from the response to reduce payload size — callers care about actionable items.

### 5. MCP Tool

**Name:** `cost_optimizer`
**Parameters:**
- `since` (optional, default "24h") — time window
- `service` (optional) — filter to specific service

Returns the same JSON structure as the REST endpoint. LLM agents can reason over classifications
and suggestions to advise users on log volume reduction.

### 6. Dashboard Widget

**Location:** New card on the main dashboard

**Components:**
- **Summary bar:** "8 noisy patterns found — 34.2% potential volume reduction"
- **Pattern table:** service, template (truncated), level badge, count, volume %, classification tag, suggestion
- **Settings gear:** opens threshold configuration (3 numeric inputs with save)
- **Service filter:** dropdown to narrow by service

**Interactions:**
- Click pattern row → navigate to existing template detail view
- Threshold changes → save to tenant settings, re-query analysis
- No "apply recommendation" actions (read-only analysis)

## Open Questions

None — brainstorming was thorough.

## Test Strategy

- **Unit tests:** Classification logic with edge cases (exactly at threshold, below, above)
- **Unit tests:** Query builder produces correct SQL for various since/service combinations
- **Unit tests:** Threshold defaults when tenant has no custom settings
- **Integration test:** End-to-end API call with seeded template_stats data
- **MCP test:** Tool returns expected structure with valid parameters
- **Dashboard:** Visual verification via Chrome DevTools MCP (manual QA)
