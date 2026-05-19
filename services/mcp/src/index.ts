#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { LogWeaveClient } from './client.js'
import { type DevToolsConfig, devDataSummary, devHealth, devQuery } from './dev-tools.js'
import {
  logweaveChanges,
  logweaveCorrelations,
  logweaveCostOptimizer,
  logweaveDeploys,
  logweaveLiveTail,
  logweaveRawLogs,
  logweaveRelatedPatterns,
  logweaveServiceOutlier,
  logweaveTraceDetails,
  logweaveDiagnoseService,
  logweaveLevelDistribution,
  logweaveListRules,
  logweaveCreateRule,
  logweaveListAlerts,
  logweaveIncidentPostmortem,
} from './tools.js'
import { registerOverview } from './registrations/overview.js'
import { registerPatterns } from './registrations/patterns.js'
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

server.registerTool(
  'changes',
  {
    title: 'Recent Changes',
    description:
      'See what changed recently: new error patterns, spiking patterns, and resolved patterns. ' +
      'Anchor to a deploy using since (ISO8601 timestamp) or deploy_id from deploys tool. ' +
      'Use this after deploys or to understand what is different from normal. ' +
      'Do not use for listing all errors — use error_patterns instead.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24). Ignored if since or deploy_id is set.'),
      service: z.string().optional().describe('Filter to a specific service name'),
      since: z.string().optional().describe('ISO8601 timestamp to anchor comparison (e.g. deploy time)'),
      deploy_id: z.string().optional().describe('Deploy ID from logweave_deploys to anchor comparison'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveChanges(client, args as { hours?: number; service?: string; since?: string; deploy_id?: string }),
  ),
)

server.registerTool(
  'deploys',
  {
    title: 'Recent Deployments',
    description:
      'List recent deployments. Use this to find deploy IDs and timestamps for anchoring changes queries. ' +
      'Returns service name, version, commit SHA, and timestamp.',
    inputSchema: {
      service: z.string().optional().describe('Filter to a specific service name'),
      limit: z.number().optional().describe('Max results to return (default: 10)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveDeploys(client, args as { service?: string; limit?: number }),
  ),
)

// ---------------------------------------------------------------------------
// Correlation & analysis tools
// ---------------------------------------------------------------------------

server.registerTool(
  'trace_details',
  {
    title: 'Trace Details',
    description:
      'Show all events sharing a trace_id, ordered chronologically across services. ' +
      'Use this to understand the full request flow when investigating an error. ' +
      'Requires a trace_id from log events. Do not guess trace IDs.',
    inputSchema: {
      trace_id: z.string().describe('Trace ID to look up (from log events or error context)'),
      hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveTraceDetails(client, args as { trace_id: string; hours?: number }),
  ),
)

server.registerTool(
  'related_patterns',
  {
    title: 'Related Patterns',
    description:
      'Find patterns that co-occur with a given template in the same request traces (causal correlation). ' +
      'Use this to answer "what else happens when this error occurs?" ' +
      'Requires a template_id from error_patterns, changes, or search_templates results.',
    inputSchema: {
      template_id: z.string().describe('Template ID to find related patterns for'),
      hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)'),
      limit: z.number().optional().describe('Max results to return (default: 20, max: 100)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveRelatedPatterns(client, args as { template_id: string; hours?: number; limit?: number }),
  ),
)

server.registerTool(
  'correlations',
  {
    title: 'Statistical Correlations',
    description:
      'Find patterns whose occurrence counts are statistically correlated with a given template (Pearson r >= 0.7). ' +
      'Unlike related_patterns (same request), this finds patterns that spike or dip at the same times — even across unrelated requests. ' +
      'Use this to find systemic issues (e.g. error in service A always spikes with error in service B).',
    inputSchema: {
      template_id: z.string().describe('Template ID to correlate against'),
      hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)'),
      limit: z.number().optional().describe('Max results to return (default: 10, max: 50)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveCorrelations(client, args as { template_id: string; hours?: number; limit?: number }),
  ),
)

server.registerTool(
  'service_outlier',
  {
    title: 'Service Outlier Detection',
    description:
      'Check if a service is having an abnormal error rate compared to its 7-day baseline (z-score). ' +
      'Returns normal, elevated (z > 1.5), or outlier (z > 2.0) verdict. ' +
      'Use this to quickly check if a service is misbehaving. Use service_health for deeper investigation.',
    inputSchema: {
      service: z.string().describe('Service name to check'),
      hours: z.number().optional().describe('Current window in hours for comparison (default: 1, max: 168)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveServiceOutlier(client, args as { service: string; hours?: number }),
  ),
)

// ---------------------------------------------------------------------------
// Raw log drill-down
// ---------------------------------------------------------------------------

server.registerTool(
  'raw_logs',
  {
    title: 'Raw Log Samples',
    description:
      'Fetch actual raw log lines that match a template pattern from the configured log source (S3, Elasticsearch, Loki, or local filesystem). ' +
      'Use this to see real log content when investigating an error — actual IPs, user IDs, error messages. ' +
      'Requires a connector to be configured in Settings. If none is configured, this tool will tell you. ' +
      'Always specify both template_id (from error_patterns, changes, or search_templates) and service.',
    inputSchema: {
      template_id: z.string().describe('Template ID to match against raw logs'),
      service: z.string().describe('Service name — required to locate the correct log source path'),
      hours: z.number().optional().describe('Time window in hours (default: 1, max: 24)'),
      limit: z.number().optional().describe('Max lines to return (default: 20, max: 100)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveRawLogs(client, args as { template_id: string; service: string; hours?: number; limit?: number }),
  ),
)

// ---------------------------------------------------------------------------
// Live tail
// ---------------------------------------------------------------------------

server.registerTool(
  'live_tail',
  {
    title: 'Live Event Stream',
    description:
      'Poll the live event buffer to see what is happening right now. Returns recent events ' +
      'from the ingest pipeline. Use cursor from previous calls to get only new events (avoids duplicates). ' +
      'Filter by service, level, template_id, or anomaly score. Requires tail to be enabled for the tenant. ' +
      'Use this during incident investigation to watch patterns emerge in real-time.',
    inputSchema: {
      service: z.string().optional().describe('Filter to a specific service'),
      level: z.string().optional().describe('Filter to exact log level (e.g. ERROR)'),
      min_level: z.string().optional().describe('Minimum severity threshold (e.g. WARN shows WARN+ERROR+FATAL)'),
      template_id: z.string().optional().describe('Filter to a specific template pattern'),
      min_anomaly: z.number().optional().describe('Minimum anomaly score (0-1)'),
      seconds: z.number().optional().describe('How far back on first call (default: 30, max: 60)'),
      limit: z.number().optional().describe('Max events to return (default: 50, max: 200)'),
      cursor: z.number().optional().describe('Sequence number from previous call — get only new events'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveLiveTail(client, args as {
      service?: string; level?: string; min_level?: string; template_id?: string;
      min_anomaly?: number; seconds?: number; limit?: number; cursor?: number
    }),
  ),
)

// ---------------------------------------------------------------------------
// New tools from gap analysis (#113)
// ---------------------------------------------------------------------------

server.registerTool(
  'diagnose_service',
  {
    title: 'Diagnose Service',
    description:
      'Full diagnostic report for a service: health metrics, outlier detection (z-score), ' +
      'and recent changes (new/spiking/resolved patterns). Combines service_health + service_outlier + changes ' +
      'into a single call. Use this when investigating why a specific service is having problems.',
    inputSchema: {
      service: z.string().describe('Service name (use list_services to discover names)'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveDiagnoseService(client, args as { service: string; hours?: number }),
  ),
)

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
  'list_rules',
  {
    title: 'List Alert Rules',
    description:
      'Show all alert rules for this tenant with their configs, status, and channel assignments. ' +
      'Use this to see what alerting is configured before creating new rules.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  toolHandler(() => logweaveListRules(client)),
)

server.registerTool(
  'create_rule',
  {
    title: 'Create Alert Rule',
    description:
      'Create an alert rule. Two types: ' +
      '(1) threshold — alert when a service metric exceeds a value (e.g. "alert if payments has >10 errors in 5 minutes"). ' +
      '(2) template_watch — alert whenever a specific log pattern appears (use after finding a pattern with error_patterns or search_templates). ' +
      'Use list_rules to verify creation.',
    inputSchema: {
      name: z.string().describe('Human-readable rule name'),
      rule_type: z
        .enum(['threshold', 'template_watch'])
        .describe('Rule type: "threshold" for metric-based alerts, "template_watch" to alert on a specific log pattern'),
      // threshold fields
      metric: z
        .enum(['error_count', 'warn_count', 'log_count'])
        .optional()
        .describe('(threshold only) Metric to monitor'),
      service: z.string().optional().describe('(threshold only) Service name to monitor'),
      operator: z.enum(['>', '>=', '<', '<=']).optional().describe('(threshold only) Comparison operator'),
      value: z.number().optional().describe('(threshold only) Threshold value'),
      window_minutes: z.number().optional().describe('(threshold only) Evaluation window in minutes (1-60)'),
      // template_watch fields
      template_id: z.string().optional().describe('(template_watch only) Template ID to watch — get this from error_patterns or search_templates'),
      template_text: z.string().optional().describe('(template_watch only) Template text for display — copy from the pattern listing'),
      // shared
      channels: z
        .array(z.string())
        .optional()
        .describe('Webhook URLs or PagerDuty routing keys for notifications (empty = tenant default)'),
    },
    annotations: WRITE_OP,
  },
  toolHandler((args) =>
    logweaveCreateRule(
      client,
      args as {
        name: string
        rule_type: 'threshold' | 'template_watch'
        metric?: string
        service?: string
        operator?: string
        value?: number
        window_minutes?: number
        template_id?: string
        template_text?: string
        channels?: string[]
      },
    ),
  ),
)

server.registerTool(
  'list_alerts',
  {
    title: 'Alert History',
    description:
      'Query recent alert history — what rules fired, when, and what triggered them. ' +
      'Filter by service or rule_id. Use this to investigate alert activity.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)'),
      rule_id: z.string().optional().describe('Filter to a specific rule ID'),
      service: z.string().optional().describe('Filter to alerts from a specific service'),
      limit: z.number().optional().describe('Max results (default: 100, max: 500)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveListAlerts(
      client,
      args as { hours?: number; rule_id?: string; service?: string; limit?: number },
    ),
  ),
)

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
