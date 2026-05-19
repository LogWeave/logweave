#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { LogWeaveClient } from './client.js'
import { type DevToolsConfig, devDataSummary, devHealth, devQuery } from './dev-tools.js'
import {
  logweaveCostOptimizer,
  logweaveLevelDistribution,
  logweaveIncidentPostmortem,
} from './tools.js'
import { registerChanges } from './registrations/changes.js'
import { registerCorrelations } from './registrations/correlations.js'
import { registerOverview } from './registrations/overview.js'
import { registerPatterns } from './registrations/patterns.js'
import { registerRaw } from './registrations/raw.js'
import { registerRules } from './registrations/rules.js'
import { READ_ONLY, WRITE_OP, toolHandler } from './shared/handler.js'

// ---------------------------------------------------------------------------
// Configuration — fail fast on missing env vars (stderr only, never stdout)
// ---------------------------------------------------------------------------

const apiUrl = process.env.LOGWEAVE_API_URL
const apiKey = process.env.LOGWEAVE_API_KEY

if (!apiUrl) {
  process.stderr.write('Error: LOGWEAVE_API_URL environment variable is required\n')
  process.exit(1)
}

if (!apiKey) {
  process.stderr.write('Error: LOGWEAVE_API_KEY environment variable is required\n')
  process.exit(1)
}

const client = new LogWeaveClient({ apiUrl, apiKey })

const server = new McpServer({
  name: 'logweave',
  version: '0.1.0',
})

registerOverview(server, client)
registerPatterns(server, client)
registerCorrelations(server, client)
registerChanges(server, client)
registerRaw(server, client)
registerRules(server, client)

// ---------------------------------------------------------------------------
// Correlation & analysis tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Raw log drill-down
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// New tools from gap analysis (#113)
// ---------------------------------------------------------------------------

server.registerTool(
  'level_distribution',
  {
    title: 'Log Level Distribution',
    description:
      'Show the DEBUG/INFO/WARN/ERROR breakdown for the system or a specific service. ' +
      'A rising WARN percentage is a leading indicator of problems, even before errors appear.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
      service: z.string().optional().describe('Filter to a specific service'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveLevelDistribution(client, args as { hours?: number; service?: string }),
  ),
)

// ---------------------------------------------------------------------------
// Alert rules + history tools
// ---------------------------------------------------------------------------

server.registerTool(
  'incident_postmortem',
  {
    title: 'Incident Post-Mortem',
    description:
      'Generate a structured post-mortem timeline for an incident on a given service. ' +
      'Combines deploy markers, pattern changes (new/spiking), outlier detection, and cross-service correlations ' +
      'into a single report. Use this after an incident to understand what happened, when, and what was affected. ' +
      'Provide since (ISO8601) to anchor the window to a deploy time or alert trigger.',
    inputSchema: {
      service: z.string().describe('Service that experienced the incident'),
      since: z
        .string()
        .optional()
        .describe('ISO8601 timestamp to start the window from (e.g. deploy time or alert trigger)'),
      hours: z
        .number()
        .optional()
        .describe('Window length in hours (default: 2). Ignored if since is provided.'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveIncidentPostmortem(
      client,
      args as { service: string; since?: string; hours?: number },
    ),
  ),
)

server.registerTool(
  'cost_optimizer',
  {
    title: 'Log Cost Optimizer',
    description:
      'Analyze log patterns to identify noise (high-volume DEBUG/TRACE) and review candidates (high-volume INFO/WARN). ' +
      'Returns patterns ranked by volume percentage with actionable suggestions for reducing log costs.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)'),
      service: z.string().optional().describe('Filter to a specific service name'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveCostOptimizer(client, args as { hours?: number; service?: string }),
  ),
)

server.registerTool(
  'compare_periods',
  {
    title: 'Compare Time Periods',
    description:
      'Compare error patterns between two time periods (e.g. "last 2 hours vs previous 2 hours"). ' +
      'Returns new, resolved, and changed patterns. Useful for spotting regressions or ' +
      'confirming a fix. Do NOT use for deploy comparisons — use the changes tool with deploy_id instead.',
    inputSchema: {
      service: z.string().optional().describe('Filter by service name'),
      recent_hours: z.number().default(2).describe('Recent period length in hours (default: 2)'),
      baseline_hours: z.number().default(2).describe('Baseline period length in hours (default: 2, starts right after recent period)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler(async (args) => {
    const { service, recent_hours = 2, baseline_hours = 2 } = args as {
      service?: string
      recent_hours?: number
      baseline_hours?: number
    }

    type TemplateRow = { templateId: string; template: string; count: number; errorCount: number; service: string }

    const params: Record<string, string | number | undefined> = { service }

    // Fetch combined window (recent + baseline) and recent window in parallel.
    // Baseline counts are derived as: combined - recent (avoids double-counting the recent period).
    const [combinedData, recentData] = await Promise.all([
      client.get('/dashboard/templates', { ...params, hours: recent_hours + baseline_hours }),
      client.get('/dashboard/templates', { ...params, hours: recent_hours }),
    ])

    const combined = ((combinedData as { data: TemplateRow[] }).data) ?? []
    const recent = ((recentData as { data: TemplateRow[] }).data) ?? []

    const combinedMap = new Map(combined.map((t) => [t.templateId, t]))
    const recentMap = new Map(recent.map((t) => [t.templateId, t]))

    // New: appeared only in the recent window (zero occurrences in baseline)
    const newPatterns = recent.filter((t) => {
      const c = combinedMap.get(t.templateId)
      const baselineCount = c ? c.count - t.count : 0
      return baselineCount <= 0
    })

    // Resolved: active in baseline window but absent from recent window
    const resolvedPatterns = combined.filter((t) => !recentMap.has(t.templateId))

    const changed: Array<{ template: string; service: string; recentCount: number; baselineCount: number; ratio: number }> = []

    for (const t of recent) {
      const c = combinedMap.get(t.templateId)
      if (!c) continue
      const baselineCount = c.count - t.count
      if (baselineCount > 0) {
        const ratio = t.count / baselineCount
        if (ratio > 2 || ratio < 0.5) {
          changed.push({
            template: t.template,
            service: t.service,
            recentCount: t.count,
            baselineCount,
            ratio,
          })
        }
      }
    }

    let text = `# Period Comparison\n\n`
    text += `**Recent:** last ${recent_hours}h | **Baseline:** ${recent_hours}h–${recent_hours + baseline_hours}h ago`
    if (service) text += ` | **Service:** ${service}`
    text += `\n\n`

    if (newPatterns.length > 0) {
      text += `## New Patterns (${newPatterns.length})\n\n`
      for (const t of newPatterns.slice(0, 10)) {
        text += `- **${t.template.slice(0, 120)}** — ${t.count} occurrences (${t.service})\n`
      }
      text += '\n'
    }

    if (resolvedPatterns.length > 0) {
      text += `## Resolved Patterns (${resolvedPatterns.length})\n\n`
      for (const t of resolvedPatterns.slice(0, 10)) {
        text += `- ~~${t.template.slice(0, 120)}~~ — was ${t.count} occurrences (${t.service})\n`
      }
      text += '\n'
    }

    if (changed.length > 0) {
      changed.sort((a, b) => b.ratio - a.ratio)
      text += `## Significant Changes (${changed.length})\n\n`
      text += `| Pattern | Service | Recent | Baseline | Change |\n|---------|---------|--------|----------|--------|\n`
      for (const c of changed.slice(0, 10)) {
        const dir = c.ratio > 1 ? `↑ ${c.ratio.toFixed(1)}x` : `↓ ${(1 / c.ratio).toFixed(1)}x`
        text += `| ${c.template.slice(0, 80)} | ${c.service} | ${c.recentCount} | ${c.baselineCount} | ${dir} |\n`
      }
      text += '\n'
    }

    if (newPatterns.length === 0 && resolvedPatterns.length === 0 && changed.length === 0) {
      text += `No significant differences between the two periods.\n`
    }

    return text
  }),
)

// ---------------------------------------------------------------------------
// Dev-only tools — registered when LOGWEAVE_DEV=true
// ---------------------------------------------------------------------------

const devMode = process.env.LOGWEAVE_DEV === 'true'

if (devMode) {
  const devConfig: DevToolsConfig = {
    clickhouseUrl: process.env.LOGWEAVE_CLICKHOUSE_URL ?? 'http://localhost:8123',
    clustererUrl: process.env.LOGWEAVE_CLUSTERER_URL ?? 'http://localhost:8000',
    apiUrl: apiUrl,
  }

  server.registerTool(
    'dev_health',
    {
      title: '[Dev] Service Health Check',
      description:
        'Check if all LogWeave services are running (API, ClickHouse, Clusterer). ' +
        'Dev-only tool — not available in production.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    toolHandler(() => devHealth(devConfig)),
  )

  server.registerTool(
    'dev_query',
    {
      title: '[Dev] ClickHouse Query',
      description:
        'Run a read-only SQL query against ClickHouse. Only SELECT, SHOW, DESCRIBE, EXPLAIN, and WITH are allowed. ' +
        'Results formatted as a markdown table (max 50 rows). Dev-only tool.',
      inputSchema: {
        sql: z.string().describe('SQL query to execute (SELECT only)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) => devQuery(devConfig, args as { sql: string })),
  )

  server.registerTool(
    'dev_data_summary',
    {
      title: '[Dev] Data Summary',
      description:
        'Show row counts, time ranges, tenant counts, and log level distribution across all LogWeave tables. ' +
        'Use this to understand what data exists. Dev-only tool.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    toolHandler(() => devDataSummary(devConfig)),
  )

  process.stderr.write('Dev mode enabled — 3 diagnostic tools registered\n')
}

// ---------------------------------------------------------------------------
// Startup — connect transport first, health check lazily
// stdout is the JSON-RPC stream — never write to it directly.
// All logging goes to stderr.
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Health check after connection (non-blocking — tools will return errors if API is down)
  try {
    await client.healthCheck()
    process.stderr.write('LogWeave MCP server connected successfully\n')
  } catch (err) {
    process.stderr.write(
      `Warning: LogWeave API health check failed at ${apiUrl}: ${err instanceof Error ? err.message : String(err)}\n` +
        'Tools will return errors until the API is reachable.\n',
    )
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
