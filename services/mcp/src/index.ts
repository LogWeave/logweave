#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { LogWeaveClient } from './client.js'
import { type DevToolsConfig, devDataSummary, devHealth, devQuery } from './dev-tools.js'
import {
  logweaveChanges,
  logweaveCorrelations,
  logweaveDeploys,
  logweaveErrorPatterns,
  logweaveLiveTail,
  logweaveOverview,
  logweaveRawLogs,
  logweaveRelatedPatterns,
  logweaveSearchTemplates,
  logweaveServiceHealth,
  logweaveServiceOutlier,
  logweaveTemplateDetail,
  logweaveTraceDetails,
  logweaveListServices,
  logweaveDiagnoseService,
  logweaveTemplateTrend,
  logweaveLevelDistribution,
  logweaveTemplateEvents,
  logweaveListRules,
  logweaveCreateRule,
  logweaveListAlerts,
  logweaveSearchByTag,
} from './tools.js'

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

// ---------------------------------------------------------------------------
// Helper: wrap tool handler with try/catch → isError response
// Never throws — tool errors are returned as isError: true so the LLM can
// recover (retry, adjust params, inform user) instead of crashing the server.
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function toolHandler(
  fn: (args: Record<string, unknown>) => Promise<string>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      const text = await fn(args)
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared annotations
// ---------------------------------------------------------------------------

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const WRITE_OP = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

// ---------------------------------------------------------------------------
// MCP Server — uses registerTool (modern API, server.tool is deprecated)
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'logweave',
  version: '0.1.0',
})

server.registerTool(
  'overview',
  {
    title: 'System Overview',
    description:
      'Get a system health overview: total events, error rate, service count, and top error patterns. ' +
      'Use this first to understand the current state of the system. ' +
      'Do not use for specific service or template queries — use service_health or template_detail instead.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) => logweaveOverview(client, args as { hours?: number })),
)

server.registerTool(
  'error_patterns',
  {
    title: 'Error Patterns',
    description:
      'List error patterns sorted by occurrence count. Only shows templates with actual errors (level=error). ' +
      'Shows template text, service, error count, and whether the pattern is new today. ' +
      'Use this to see what errors are happening across all services. For a single service, pass the service parameter.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
      service: z.string().optional().describe('Filter to a specific service name'),
      limit: z.number().optional().describe('Max results to return (default: 100)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveErrorPatterns(client, args as { hours?: number; service?: string; limit?: number }),
  ),
)

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
  'template_detail',
  {
    title: 'Template Detail',
    description:
      'Deep dive on a specific error pattern: occurrence history, status codes, affected services, anomaly score. ' +
      'Use a template_id from error_patterns or changes results. ' +
      'Do not use without a template_id.',
    inputSchema: {
      template_id: z.string().describe('Template ID to look up (from error_patterns or changes results)'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveTemplateDetail(client, args as { template_id: string; hours?: number }),
  ),
)

server.registerTool(
  'service_health',
  {
    title: 'Service Health',
    description:
      'Health report for a specific service: error rate, log volume, top error patterns, and volume trend. ' +
      'Use this to check if a specific service is having problems. ' +
      'Do not use for cross-service overview — use overview instead.',
    inputSchema: {
      service: z.string().describe('Service name to check'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveServiceHealth(client, args as { service: string; hours?: number }),
  ),
)

server.registerTool(
  'search_templates',
  {
    title: 'Search Templates',
    description:
      'Search for error patterns by text. Supports two modes: ' +
      '"substring" (default, exact text matching) and "semantic" (finds conceptually related patterns — ' +
      'e.g. "database slow" matches "connection pool exhausted"). Use semantic mode when the exact wording is unknown. ' +
      'Minimum 3 characters.',
    inputSchema: {
      query: z.string().describe('Search text (minimum 3 characters)'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
      limit: z.number().optional().describe('Max results to return (default: 100)'),
      mode: z.enum(['substring', 'semantic']).optional().describe('Search mode (default: substring)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveSearchTemplates(client, args as { query: string; hours?: number; limit?: number; mode?: string }),
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
      'Fetch actual raw log lines that match a template pattern from the customer\'s S3 storage. ' +
      'Use this to see real log content when investigating an error — actual IPs, user IDs, error messages. ' +
      'Requires a configured S3 connector. If none is configured, this tool will tell you. ' +
      'Always specify both template_id (from error_patterns, changes, or search_templates) and service.',
    inputSchema: {
      template_id: z.string().describe('Template ID to match against raw logs'),
      service: z.string().describe('Service name — required to locate the correct S3 path'),
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
  'list_services',
  {
    title: 'List Services',
    description:
      'List all services with error rates, log volumes, and anomaly scores. ' +
      'Use this to discover which services exist and which need attention. ' +
      'Start here when you need to find service names for service_health or diagnose_service.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) => logweaveListServices(client, args as { hours?: number })),
)

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
  'template_trend',
  {
    title: 'Template Long-Term Trend',
    description:
      'Get daily occurrence counts for a template over up to 365 days. ' +
      'Use this to determine if a pattern is getting worse over weeks/months, or if it is seasonal. ' +
      'For short-term trends (hours), use template_detail instead.',
    inputSchema: {
      template_id: z.string().describe('Template ID (from error_patterns, changes, or search_templates)'),
      days: z.number().optional().describe('Number of days to look back (default: 90, max: 365)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveTemplateTrend(client, args as { template_id: string; days?: number }),
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

server.registerTool(
  'template_events',
  {
    title: 'Template Events',
    description:
      'Get individual log events for a template pattern. Shows timestamp, service, route, status code, ' +
      'duration, and trace ID for each event. Filter by status code to investigate specific error types. ' +
      'Use trace IDs with trace_details to follow requests across services.',
    inputSchema: {
      template_id: z.string().describe('Template ID'),
      status_code: z.number().optional().describe('Filter to a specific HTTP status code (e.g. 500)'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
      limit: z.number().optional().describe('Max events to return (default: 20, max: 100)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveTemplateEvents(
      client,
      args as { template_id: string; status_code?: number; hours?: number; limit?: number },
    ),
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
      'Create a threshold alert rule. Example: "alert if payments has >10 errors in 5 minutes." ' +
      'The rule will be evaluated every 60 seconds. Use list_rules to verify creation.',
    inputSchema: {
      name: z.string().describe('Human-readable rule name (e.g. "High error rate on payments")'),
      metric: z
        .enum(['error_count', 'warn_count', 'log_count'])
        .describe('Metric to monitor'),
      service: z.string().describe('Service name to monitor'),
      operator: z.enum(['>', '>=', '<', '<=']).describe('Comparison operator'),
      value: z.number().describe('Threshold value'),
      window_minutes: z.number().describe('Evaluation window in minutes (1-60)'),
      channels: z
        .array(z.string())
        .optional()
        .describe('Slack webhook URLs for notifications (empty = tenant default)'),
    },
    annotations: WRITE_OP,
  },
  toolHandler((args) =>
    logweaveCreateRule(
      client,
      args as {
        name: string
        metric: string
        service: string
        operator: string
        value: number
        window_minutes: number
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
  'search_by_tag',
  {
    title: 'Search by Tag',
    description:
      'Find events by a custom metadata tag (customer_id, order_id, user_id, etc.). ' +
      'Only works if the tenant has configured tag extraction in Settings. ' +
      'Use this when investigating a specific customer, order, or request.',
    inputSchema: {
      key: z.string().describe('Tag key to search (e.g. "customer_id", "order_id")'),
      value: z.string().describe('Tag value to match (e.g. "ACME-123")'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
      limit: z.number().optional().describe('Max results (default: 50, max: 200)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveSearchByTag(
      client,
      args as { key: string; value: string; hours?: number; limit?: number },
    ),
  ),
)

server.registerTool(
  'clustering_health',
  {
    title: 'Clustering Health',
    description:
      'Check the health of the log clustering pipeline. Reports ClickHouse connectivity, ' +
      'clusterer circuit breaker state, consecutive failures, and key metrics (ingested, clustered, ' +
      'unclustered counts). Use this when data seems stale or patterns are not updating.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  toolHandler(async () => {
    const data = await client.get('/readyz')
    const r = data as {
      status: string
      clickhouse: string
      clusterer: { status: string; consecutiveFailures: number; circuitOpen: boolean }
      metrics: Record<string, number>
    }

    let text = `# Clustering Pipeline Health\n\n`
    text += `**Overall:** ${r.status}\n`
    text += `**ClickHouse:** ${r.clickhouse}\n`
    text += `**Clusterer:** ${r.clusterer.status}`
    if (r.clusterer.circuitOpen) {
      text += ` ⚠ CIRCUIT OPEN (${r.clusterer.consecutiveFailures} consecutive failures)\n`
      text += `\nThe circuit breaker is open — new events are being stored as unclustered (template_id=0) and will be re-clustered when the clusterer recovers.\n`
    } else if (r.clusterer.consecutiveFailures > 0) {
      text += ` (${r.clusterer.consecutiveFailures} recent failures)\n`
    } else {
      text += `\n`
    }
    text += `\n## Metrics\n\n`
    text += `| Metric | Value |\n|--------|-------|\n`
    for (const [key, val] of Object.entries(r.metrics)) {
      text += `| ${key} | ${val} |\n`
    }
    return text
  }),
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

    const serviceFilter = service ? `&service=${encodeURIComponent(service)}` : ''

    // Fetch both periods in parallel
    const [recentData, baselineData] = await Promise.all([
      client.get(`/v1/templates?hours=${recent_hours}${serviceFilter}`),
      client.get(`/v1/templates?hours=${recent_hours + baseline_hours}${serviceFilter}`),
    ])

    const recent = ((recentData as { data: Array<{ templateId: string; template: string; count: number; errorCount: number; service: string }> }).data) ?? []
    const baseline = ((baselineData as { data: Array<{ templateId: string; template: string; count: number; errorCount: number; service: string }> }).data) ?? []

    const recentMap = new Map(recent.map((t) => [t.templateId, t]))
    const baselineMap = new Map(baseline.map((t) => [t.templateId, t]))

    const newPatterns = recent.filter((t) => !baselineMap.has(t.templateId))
    const resolvedPatterns = baseline.filter((t) => !recentMap.has(t.templateId))
    const changed: Array<{ template: string; service: string; recentCount: number; baselineCount: number; ratio: number }> = []

    for (const t of recent) {
      const b = baselineMap.get(t.templateId)
      if (b && b.count > 0) {
        const ratio = t.count / b.count
        if (ratio > 2 || ratio < 0.5) {
          changed.push({
            template: t.template,
            service: t.service,
            recentCount: t.count,
            baselineCount: b.count,
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
