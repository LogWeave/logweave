# Onboarding Flow Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Issue:** #93

## Goal

Get new users from "just deployed" to "seeing the value of LogWeave" in under 5 minutes, with the MCP AI integration as the payoff moment.

## Approach

Inline dashboard checklist card (not a modal wizard). Derives completion state from actual system state, not a boolean. Three steps: Send Logs → Tune Clustering → Connect AI. Desktop-only.

## Scope

**In scope:**
- Onboarding checklist card on dashboard (prominent when empty, corner card when data exists)
- Step 1: Send logs — choose method (Winston/curl/OTel/sample data), pre-filled API key, live polling for first event
- Step 2: Tune clustering — 3 preset cards (Conservative/Balanced/Aggressive) with real data examples using preview endpoint (#135)
- Step 3: Connect AI — pre-filled MCP config snippet with copy button, optional Test Connection
- "Try with sample data" option — runs simulator against isolated demo-tenant
- Sidebar "Setup" item with badge showing incomplete step count
- Skip/dismiss at any level (individual steps or entire checklist)
- Auto-detect completed steps from system state

**Out of scope / deferred:**
- Mobile responsive wizard (desktop-only)
- Guided walkthrough of dashboard features (tooltips/tour — separate issue)
- Per-service clustering sensitivity
- Full wizard with page transitions (checklist is simpler, build wizard if data shows drop-off)
- Onboarding analytics/funnel tracking

## Design

### 1. State Detection (no booleans)

Completion is derived from actual system state, not stored flags:

| Step | Complete when | Source |
|------|--------------|--------|
| Send Logs | `totalEvents > 0` for the tenant | `GET /v1/dashboard/overview` |
| Tune Clustering | `clusteringSensitivity` has been explicitly set | `tenant_settings` |
| Connect AI | User has dismissed this step (localStorage) | Browser only |

One stored flag: `onboarding_dismissed_at` in tenant_settings — set when user clicks "Skip setup" or closes the checklist. Second team members see the dashboard (not the checklist) if data exists.

### 2. Checklist Card

**When `totalEvents === 0`:** Full-width centered card on the dashboard, empty dashboard visible but dimmed behind it.

```
┌─────────────────────────────────────────────────────┐
│  Get started with LogWeave                  [Close] │
│                                                     │
│  ○  Send your first logs                   [Start]  │
│  ○  Tune clustering sensitivity            [Start]  │
│  ○  Connect your AI assistant              [Start]  │
│                                                     │
│  [Skip setup — go to dashboard]                     │
└─────────────────────────────────────────────────────┘
```

**When `totalEvents > 0` but steps incomplete:** Small card in dashboard, collapsible.

**When all steps done or dismissed:** Card disappears. "Setup" sidebar item removed.

Clicking "Start" expands that item inline — no page transitions.

### 3. Step 1 — Send Logs

**Choose your method:**

```
How do you want to send logs?

[Node.js App]     [Any HTTP Client]     [OpenTelemetry]     [Try Sample Data]
   Winston SDK        curl / fetch       OTel Collector      See it instantly
```

Each option expands to show a pre-filled code snippet with the tenant's real API key and a copy button.

**"Try Sample Data":**
- Adds `demo-key` → `demo-tenant` to API keys (pre-configured)
- Starts the built-in simulator against demo-tenant for 60 seconds
- Dashboard temporarily switches to viewing demo-tenant data
- Banner: "Viewing sample data. [Connect your real logs] to switch to your account."
- When user connects real logs (real tenant gets events), auto-switch back

**Live detection:**
- Poll `GET /v1/dashboard/overview` every 3 seconds
- Pulsing animation: "Waiting for first log..."
- On first event: green checkmark, "First log received!" with 1-second pause
- After 10 minutes with no data: "Haven't received data yet. [Troubleshooting guide] [Skip]"

### 4. Step 2 — Tune Clustering

Requires Step 1 complete (needs data to preview).

Auto-runs the clustering preview endpoint (#135) at three preset levels:

```
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│   Conservative   │ │    Balanced ✓    │ │    Aggressive    │
│    sim_th: 0.3   │ │   sim_th: 0.4    │ │   sim_th: 0.6   │
│                  │ │                  │ │                  │
│  245 patterns    │ │  120 patterns    │ │  35 patterns     │
│  4:1 compression │ │  8:1 compression │ │  28:1 compression│
│                  │ │                  │ │                  │
│  "Login failed   │ │  "Login failed   │ │  "Login <*>"     │
│   for user X"    │ │   for user <*>"  │ │                  │
│  "Login failed   │ │                  │ │                  │
│   for user Y"    │ │                  │ │                  │
│  → 2 templates   │ │  → 1 template    │ │  → 1 template    │
│                  │ │                  │ │                  │
│     [Select]     │ │   [Selected]     │ │     [Select]     │
└──────────────────┘ └──────────────────┘ └──────────────────┘

                    [Apply & Continue]
```

Shows real examples from their actual log data. "Balanced" pre-selected as default.

If fewer than 20 events: "We need a bit more data to show meaningful groupings. You can tune this anytime in Settings. [Skip for now]"

### 5. Step 3 — Connect AI (The Payoff)

Pre-filled MCP config with copy button:

```
Connect LogWeave to your AI assistant

Paste this into your .mcp.json (Claude Code, Cursor, Windsurf):

┌──────────────────────────────────────────────┐
│ {                                            │
│   "mcpServers": {                            │
│     "logweave": {                            │
│       "command": "npx",                      │
│       "args": ["@logweave/mcp"],             │
│       "env": {                               │
│         "LOGWEAVE_API_KEY": "lw_xxx...",      │
│         "LOGWEAVE_API_URL": "http://..."      │
│       }                                      │
│     }                                        │
│   }                                          │
│ }                                    [Copy]  │
└──────────────────────────────────────────────┘

Then try asking your AI:
  "What errors are happening in my app?"
  "What changed after the last deploy?"
  "Which service has the highest error rate?"

[Test Connection]  [Done — show me the dashboard]

Using a different AI tool? LogWeave also has a REST API. →
```

"Test Connection" hits a health endpoint through the MCP path and shows success/error.

### 6. Re-entry

- **Sidebar:** "Setup" item with badge (e.g., "1/3") visible until all steps complete or dismissed
- **Settings page:** Clustering sensitivity and MCP config available permanently (not onboarding-specific)
- **No wizard re-launch** — the checklist format means items are always accessible inline

### 7. Demo Tenant Isolation

Pre-configured in API keys:
```json
{
  "dev-key": "dev-tenant",
  "demo-key": "demo-tenant"
}
```

- Simulator sends to `demo-tenant` when "Try Sample Data" is clicked
- Dashboard reads from `demo-tenant` during sample mode
- Real tenant data is never mixed with demo data
- Demo tenant has its own TTL / can be cleaned up on demand
- Banner clearly indicates "Viewing sample data"

## Open Questions

None.

## Test Strategy

- Checklist renders when `totalEvents === 0`
- Checklist hides when `totalEvents > 0` and all steps dismissed
- Step 1: polling detects first event and marks complete
- Step 2: preview endpoint returns comparison data at 3 sensitivity levels
- Step 3: MCP config snippet is pre-filled with correct API key
- Sample data mode: simulator starts, dashboard shows demo-tenant data, banner visible
- Skip/dismiss persists correctly
- Second team member sees dashboard (not checklist) when data exists
