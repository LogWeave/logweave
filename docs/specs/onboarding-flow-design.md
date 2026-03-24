# Onboarding Flow Design Spec (v2)

**Date:** 2026-03-24
**Status:** Approved (revised after UX specialist + 2 persona reviews)
**Issue:** #93

## Goal

Get new users from "just deployed" to "seeing the value of LogWeave" in under 5 minutes, with the MCP AI integration as the payoff moment.

## Approach

Inline dashboard checklist card (not a modal wizard). Three steps: Send Logs → Connect AI → Tune Clustering. State derived from system, not booleans. Desktop-only.

## Key Decisions (from review feedback)

- **No demo tenant / sample data** — too complex, adds tenant-switching auth headaches. Instead show a short animation/GIF of the dashboard in action (5 seconds, looping). Full demos live on the website.
- **MCP before clustering** — the AI connection is the wow moment. Clustering tuning is optimization that comes after.
- **Value proposition first** — one-line explanation of what LogWeave is above the checklist.
- **Language-neutral framing** — HTTP API works for any language, not just Node.js.
- **Sensitivity = plain English** — "More specific ← → More general", no numbers, no `sim_th`.
- **MCP completion = server-side** — track `last_mcp_connection_at` in tenant_settings. Per-user dismissal in localStorage.
- **Animations** — pulsing while waiting, checkmark on success, smooth transitions. Product should feel alive.

## Scope

**In scope:**
- Onboarding checklist card on dashboard (full-width when empty, dismissible card when data exists)
- Value proposition line above checklist
- Animated preview of dashboard in action (5-second GIF/loop, dismissible)
- Step 1: Send logs — language-neutral tabs (SDK/HTTP API/OpenTelemetry), pre-filled API key, live polling for first event with pulsing animation
- Step 2: Connect AI — explain what MCP is in one sentence, show the payoff (what AI can answer), then the config snippet. REST API fallback for non-MCP users.
- Step 3: Tune clustering — "More specific ← → More general" simple toggle with plain English descriptions. Uses preview endpoint (#135) if available, static examples as fallback.
- Sidebar "Setup" item with badge until complete
- Skip/dismiss at every level
- Celebration moment on completion
- Time estimates per step (~2min, ~1min, ~1min)

**Out of scope:**
- Demo tenant / sample data mode (dropped — too complex for the value)
- Mobile responsive (desktop-only)
- Team invitation flow (separate feature)
- S3 connector setup (separate flow in Settings after onboarding)
- Onboarding analytics / funnel tracking
- Full wizard with page transitions

## Design

### 1. State Detection

| Step | Complete when | Source |
|------|--------------|--------|
| Send Logs | `totalEvents > 0` | API overview endpoint |
| Connect AI | `last_mcp_connection_at` set | tenant_settings (server-side) |
| Tune Clustering | `clusteringSensitivity` explicitly set | tenant_settings |

Additional: `onboarding_dismissed_at` in tenant_settings for "Skip setup". Second team members see dashboard (not checklist) if `totalEvents > 0`.

### 2. Checklist Card

When `totalEvents === 0` — full-width centered, dashboard dimmed behind:

```
LogWeave extracts patterns from your logs.
Your AI queries the patterns. Raw logs stay in your infrastructure.

[5-second animated preview of dashboard in action]

Get started                                    [I'll set this up later]

  ○  Send your first logs          ~2 min                      [Start]
  ○  Connect your AI assistant     ~1 min                      [Start]
  ○  Tune clustering sensitivity   ~1 min                      [Start]
```

When `totalEvents > 0` but steps incomplete — small collapsible card.
When all done or dismissed — gone. "Setup" sidebar item removed.

### 3. Step 1 — Send Logs

**Language-neutral tabs:**

```
How do you want to send logs?

  [SDK (Node.js)]    [HTTP API]         [OpenTelemetry]
   Winston / Pino     Any language        OTel Collector
```

**SDK tab:** Sub-options for Winston and Pino with pre-filled snippets.

**HTTP API tab:** Language-specific snippets:
- curl (universal, shown first)
- Go (http.Post)
- Python (requests.post)
- Java (HttpClient)

All snippets pre-filled with the tenant's real API key and endpoint URL.

**OTel tab:** Collector config YAML with exporter pointing at `/v1/logs`.

**Live detection:**
- Poll every 5 seconds for first minute, then every 10 seconds
- Pulsing animation: "Waiting for your first log..."
- On first event: green checkmark animation, "First log received!" (1-second pause)
- After 2 minutes: "Haven't received data yet. Check that your service is sending to the right URL. [Troubleshooting]"
- After 5 minutes: stop polling, static message

### 4. Step 2 — Connect AI (The Payoff)

**Lead with the value, not the config:**

```
Ask your AI about your production logs

LogWeave connects to AI coding assistants via MCP (Model Context Protocol).
Once connected, your AI can answer questions like:

  "What new error patterns appeared after my last deploy?"
  "Is my payment-service error rate abnormal right now?"
  "What other services are affected when auth times out?"

[Animated mockup showing AI conversation with real-looking responses]

Paste into your editor's MCP config (Claude Code, Cursor, Windsurf, VS Code):

┌──────────────────────────────────────────────┐
│ {                                            │
│   "mcpServers": {                            │
│     "logweave": { ... }                      │
│   }                                          │
│ }                                    [Copy]  │
└──────────────────────────────────────────────┘

[Done]

Using a different AI tool? LogWeave also has a full REST API. →
```

**MCP completion detection:** When the MCP server makes its first API call, the `User-Agent` header identifies it as `@logweave/mcp`. Set `last_mcp_connection_at` in tenant_settings on first such request.

### 5. Step 3 — Tune Clustering

Simple choice, no numbers:

```
How should LogWeave group your log patterns?

  ○ More specific   — treats small differences as separate patterns
                       "Login failed for user alice" ≠ "Login failed for user bob"

  ● Balanced         — groups similar messages, keeps meaningful differences
                       "Login failed for user <*>" (recommended)

  ○ More general    — maximum compression, may lose important distinctions
                       "Login <*>"

                    [Apply]   [Skip — use default]
```

Uses clustering preview endpoint (#135) to show real examples from their data if available. Falls back to static examples if preview endpoint isn't built yet or insufficient data.

"You can change this anytime in Settings."

### 6. Completion

When all three steps are done:

```
┌─────────────────────────────────────────────┐
│  ✓  You're all set!                         │
│                                             │
│  LogWeave is monitoring your services.      │
│  Ask your AI assistant about your logs.     │
│                                             │
│           [Go to Dashboard]                 │
└─────────────────────────────────────────────┘
```

Brief celebration animation (checkmark, subtle confetti or glow). Card fades after 5 seconds or on click.

### 7. Re-entry

- Sidebar "Setup" item with badge (e.g., "1/3") until all steps done or dismissed
- Settings page has clustering sensitivity and MCP config permanently
- No wizard re-launch — just the settings pages

## Open Questions

None.

## Test Strategy

- Checklist renders when `totalEvents === 0`
- Checklist hides when data exists and all steps complete/dismissed
- Step 1: polling detects first event, animation plays
- Step 2: MCP config pre-filled, completion detected server-side via User-Agent
- Step 3: clustering choice persists to tenant_settings
- Skip/dismiss persists correctly
- Second team member sees dashboard, not checklist, when data exists
- Animated preview displays and dismisses correctly
