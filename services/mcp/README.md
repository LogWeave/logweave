# @logweave/mcp

LogWeave's Model Context Protocol server — gives AI assistants (Claude Code, Claude Desktop, Cursor, etc.) structured tools for querying your log intelligence.

LogWeave extracts log patterns via Drain3 clustering and stores metadata only (never raw content). This package surfaces that intelligence as MCP tools so an assistant can answer "what just broke?" without you copy-pasting log lines.

## Install

```bash
npx @logweave/mcp
```

Or install globally:

```bash
npm install -g @logweave/mcp
logweave-mcp
```

## Configure

Two environment variables:

- `LOGWEAVE_API_URL` — base URL of your LogWeave API (e.g. `https://logs.example.com` or `http://localhost:3000`)
- `LOGWEAVE_API_KEY` — API key from your LogWeave dashboard (Settings → API Keys)

### Claude Desktop / Claude Code

Add to your MCP config (`~/.config/claude-desktop/config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "logweave": {
      "command": "npx",
      "args": ["@logweave/mcp"],
      "env": {
        "LOGWEAVE_API_URL": "https://logs.example.com",
        "LOGWEAVE_API_KEY": "lw_..."
      }
    }
  }
}
```

## Tools

The server registers 27 tools (plus 3 dev-only tools when `LOGWEAVE_DEV=1`):

**Overview & health** — `overview`, `service_health`, `clustering_health`, `list_services`, `level_distribution`, `compare_periods`

**Patterns & search** — `error_patterns`, `search_templates`, `search_by_tag`, `template_detail`, `template_trend`, `template_events`, `related_patterns`, `correlations`

**Changes & incidents** — `changes`, `deploys`, `service_outlier`, `diagnose_service`, `incident_postmortem`, `cost_optimizer`

**Traces & raw logs** — `trace_details`, `raw_logs`, `live_tail`

**Rules & alerts** — `list_rules`, `create_rule`, `list_alerts`

## License

MIT — see [LICENSE](../../LICENSE).
