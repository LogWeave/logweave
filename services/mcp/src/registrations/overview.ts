import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LogWeaveClient } from '../client.js'
import { type ApiResponse, formatMeta, READ_ONLY, toolHandler } from '../shared/handler.js'
import {
  buildSystemNotes,
  formatSystemStateBlock,
  getAnomalyState,
} from '../shared/system-state.js'

async function overview(client: LogWeaveClient, args: { hours?: number }): Promise<string> {
  const [res, anomalyState] = await Promise.all([
    client.getComposite('/overview', { hours: args.hours }) as Promise<ApiResponse>,
    getAnomalyState(client),
  ])

  const d = res.data as Record<string, unknown>
  const patterns = (d.topErrorPatterns as Array<Record<string, unknown>>) ?? []

  let text = `## System Overview\n\n`
  text += `- Total events: ${d.totalEvents}\n`
  text += `- Unique templates: ${d.totalTemplates}\n`
  text += `- New today: ${d.newTemplatesToday}\n`
  text += `- Unclustered: ${d.unclusteredCount}\n`
  text += `- Error rate: ${((d.errorRate as number) * 100).toFixed(1)}%\n`
  text += `- Services: ${d.serviceCount}\n`

  if (patterns.length > 0) {
    text += `\n### Top Error Patterns\n\n`
    for (const p of patterns) {
      const services = (p.servicesAffected as string[]).join(', ')
      text += `- **${p.templateText}** [id: ${p.templateId}] — ${p.occurrenceCount} occurrences (${services})\n`
    }
  }

  text += formatMeta(res.meta)

  // Self-aware system-state block so LLM agents know whether to trust low
  // anomaly numbers or treat them as "system warming up".
  const notes = buildSystemNotes(anomalyState, null)
  text += formatSystemStateBlock(notes)

  return text
}

async function serviceHealth(
  client: LogWeaveClient,
  args: { service: string; hours?: number },
): Promise<string> {
  const res = (await client.getComposite(`/services/${args.service}/health`, {
    hours: args.hours,
  })) as ApiResponse

  const d = res.data as Record<string, unknown>
  const patterns = (d.topErrorPatterns as Array<Record<string, unknown>>) ?? []
  const trend = (d.volumeTrend as Array<Record<string, unknown>>) ?? []

  let text = `## Service Health: ${d.service}\n\n`
  text += `- Log count: ${d.logCount}\n`
  text += `- Error count: ${d.errorCount} (${((d.errorRate as number) * 100).toFixed(1)}%)\n`
  text += `- Warn count: ${d.warnCount} (${((d.warnRate as number) * 100).toFixed(1)}%)\n`

  if (patterns.length > 0) {
    text += `\n### Top Error Patterns\n`
    for (const p of patterns) {
      text += `- **${p.templateText}** — ${p.occurrenceCount} occurrences\n`
    }
  }

  if (trend.length > 0) {
    const logCounts = trend.map((t) => t.logCount as number)
    const errCounts = trend.map((t) => t.errorCount as number)
    const totalLogs = logCounts.reduce((a, b) => a + b, 0)
    const totalErrors = errCounts.reduce((a, b) => a + b, 0)
    const maxLogs = Math.max(...logCounts)
    const maxErrors = Math.max(...errCounts)

    // Trend direction from first vs last third
    const third = Math.max(1, Math.floor(logCounts.length / 3))
    const firstThirdAvg = logCounts.slice(0, third).reduce((a, b) => a + b, 0) / third
    const lastThirdAvg = logCounts.slice(-third).reduce((a, b) => a + b, 0) / third
    const trendDir =
      lastThirdAvg > firstThirdAvg * 1.2
        ? 'volume trending UP'
        : lastThirdAvg < firstThirdAvg * 0.8
          ? 'volume trending DOWN'
          : 'volume stable'

    text += `\n### Volume Trend (${trend.length} intervals)\n`
    text += `- Direction: ${trendDir}\n`
    text += `- Total: ${totalLogs} logs, ${totalErrors} errors\n`
    text += `- Peak volume: ${maxLogs} logs/interval, peak errors: ${maxErrors}/interval\n`
    text += `- Latest: ${trend[trend.length - 1].intervalStart}: ${trend[trend.length - 1].logCount} logs, ${trend[trend.length - 1].errorCount} errors\n`
  }

  text += formatMeta(res.meta)
  return text
}

async function listServices(client: LogWeaveClient, args: { hours?: number }): Promise<string> {
  const res = (await client.get('/dashboard/services', { hours: args.hours })) as ApiResponse
  const rows = (res.data as Array<Record<string, unknown>>) ?? []

  if (rows.length === 0) {
    return `No services found.${formatMeta(res.meta)}`
  }

  let text = `## Services (${rows.length})\n\n`
  for (const r of rows) {
    const errorRate = ((r.errorRate as number) * 100).toFixed(1)
    text += `- **${r.service}** — ${r.logCount} logs, ${r.errorCount} errors (${errorRate}%)`
    if ((r.newTemplateCount as number) > 0) {
      text += ` [${r.newTemplateCount} new patterns]`
    }
    text += '\n'
  }

  text += formatMeta(res.meta)
  return text
}

async function clusteringHealth(client: LogWeaveClient): Promise<string> {
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
}

export function registerOverview(server: McpServer, client: LogWeaveClient): void {
  server.registerTool(
    'overview',
    {
      title: 'System Overview',
      description:
        'Get a system health overview: total events, error rate, service count, and top error patterns. ' +
        'Use this first to understand the current state of the system. ' +
        'Do not use for specific service or template queries — use service_health or template_detail instead.',
      inputSchema: {
        hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe('Time window in hours (default: 24, max: 720)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) => overview(client, args as { hours?: number })),
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
        hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe('Time window in hours (default: 24, max: 720)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) => serviceHealth(client, args as { service: string; hours?: number })),
  )

  server.registerTool(
    'list_services',
    {
      title: 'List Services',
      description:
        'List all services with error rates, log volumes, and anomaly scores. ' +
        'Use this to discover which services exist and which need attention. ' +
        'Start here when you need to find service names for service_health or diagnose_service.',
      inputSchema: {
        hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe('Time window in hours (default: 24, max: 720)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) => listServices(client, args as { hours?: number })),
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
    toolHandler(() => clusteringHealth(client)),
  )
}
