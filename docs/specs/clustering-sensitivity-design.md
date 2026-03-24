# Per-Tenant Clustering Sensitivity Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Issue:** TBD

## Goal

Let users tune how specific or generic their log templates are, with a live preview that shows the impact before committing — so nobody breaks their patterns blindly.

## Approach

Settings UI slider for Drain3 `sim_th` (0.2–0.8), with a live preview endpoint that dry-runs clustering on a sample of recent logs without persisting anything. Two apply modes: "new logs only" (safe) and "reset & relearn" (with confirmation dialog).

## Scope

**In scope:**
- `clusteringSensitivity` field in TenantSettings (stored in ClickHouse)
- API reads setting and passes `sim_th` to clusterer in POST /cluster request
- Clusterer accepts per-request `sim_th` override, uses it for that tenant's miner
- New clusterer endpoint: POST /cluster/preview — throwaway miner, returns pattern count + compression ratio + sample templates
- API endpoint: POST /v1/settings/clustering/preview — fetches recent pre_processed_messages, forwards to clusterer preview
- Settings UI: slider (0.2–0.8, default 0.4) with live preview card showing pattern count and compression ratio
- Two apply modes:
  - "Apply to new logs" — updates sim_th, existing miner stays (gradual transition)
  - "Reset & relearn" — updates sim_th + clears tenant's Drain3 state (confirmation dialog: "This resets pattern recognition. Your log data and history are not affected. New patterns will be learned from incoming logs within minutes.")
- Clusterer endpoint: POST /cluster/reset — clears a tenant's miner state

**Out of scope / deferred:**
- Onboarding wizard with multi-sensitivity comparison (builds on same preview endpoint — separate issue)
- Automatic sensitivity recommendation based on log analysis
- Per-service sensitivity (one value per tenant for now)
- Retroactive re-clustering of historical data

## Design

### 1. Data Flow

```
Settings UI (slider)
  → POST /v1/settings/clustering/preview { simTh: 0.3 }
  → API fetches last 1000 pre_processed_messages from ClickHouse
  → POST clusterer /cluster/preview { messages: [...], sim_th: 0.3 }
  → Clusterer creates throwaway TemplateMiner, clusters sample
  → Returns { patternCount, compressionRatio, sampleTemplates }
  → UI shows preview card with results

User commits:
  → PUT /v1/settings { clusteringSensitivity: 0.3 }
  → Stored in tenant_settings (ClickHouse)
  → If "reset": POST clusterer /cluster/reset { tenant_id }

Ongoing ingestion:
  → API reads clusteringSensitivity from settingsStore
  → Passes sim_th in POST /cluster request body
  → Clusterer uses per-request sim_th for that tenant's miner
```

### 2. Clusterer Changes

**POST /cluster** — add optional `sim_th` field to request body:
```python
class ClusterRequest(BaseModel):
    tenant_id: str
    messages: list[str]
    sim_th: float | None = None  # per-tenant override
```

When `sim_th` is provided and differs from the tenant's current miner, recreate the miner with the new threshold (for "reset & relearn" mode). For "apply to new logs" mode, the existing miner continues with its built-up tree — the new `sim_th` only affects how new messages match against existing clusters.

**POST /cluster/preview** — new endpoint:
```python
class PreviewRequest(BaseModel):
    messages: list[str]
    sim_th: float = 0.4

class PreviewResponse(BaseModel):
    pattern_count: int
    compression_ratio: float
    sample_templates: list[str]  # top 10 by frequency
```

Creates a temporary TemplateMiner, clusters all messages, returns stats. No side effects.

**POST /cluster/reset** — new endpoint:
```python
class ResetRequest(BaseModel):
    tenant_id: str
```

Deletes the tenant's TemplateMiner from the in-memory dict. Next cluster request creates a fresh one.

### 3. API Changes

- Add `clusteringSensitivity` to TenantSettings (float, optional, default undefined = use global 0.4)
- POST /v1/settings/clustering/preview: fetches last 1000 pre_processed_messages from ClickHouse, forwards to clusterer preview
- Ingest pipeline: reads `clusteringSensitivity` from settingsStore, passes as `sim_th` to cluster client

### 4. Settings UI

- New "Clustering" section on Settings page (below Slack)
- Slider: 0.2 (More Specific) ← → 0.8 (More Generic), current value displayed
- Preview card (updates on slider change with debounce):
  - Pattern count
  - Compression ratio
  - Top 5 sample templates
- "Apply to new logs" button (safe, default)
- "Reset & relearn" button (shows confirmation dialog)

## Open Questions

None.

## Test Strategy

- Clusterer: unit test for /cluster/preview (throwaway miner returns correct stats)
- Clusterer: unit test for /cluster/reset (miner cleared, next request creates new one)
- API: test that clusteringSensitivity is read from settings and passed to cluster client
- Dashboard: visual test that slider updates preview card
- Integration: change sensitivity, send logs, verify new templates reflect the new threshold
