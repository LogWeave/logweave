import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LogWeaveClient } from '../client.js'
import { type ApiResponse, READ_ONLY, formatMeta, toolHandler } from '../shared/handler.js'

async function errorPatterns(
  client: LogWeaveClient,
  args: { hours?: number; service?: string; limit?: number },
): Promise<string> {
  const res = (await client.get('/dashboard/templates', {
    hours: args.hours,
    service: args.service,
    limit: args.limit,
    sort: 'occurrence',
    level: 'ERROR',
  })) as ApiResponse

  const rows = (res.data as Array<Record<string, unknown>>) ?? []

  if (rows.length === 0) {
    return `No error patterns found.${formatMeta(res.meta)}`
  }

  let text = `## Error Patterns (${rows.length} results)\n\n`
  for (const r of rows) {
    const badge = r.isNewToday ? ' [NEW]' : ''
    text += `- **${r.templateText}** [id: ${r.templateId}]${badge}\n`
    text += `  Service: ${r.service} | Count: ${r.occurrenceCount} | Errors: ${r.errorCount}\n`
  }

  text += formatMeta(res.meta)
  return text
}

async function templateDetail(
  client: LogWeaveClient,
  args: { template_id: string; hours?: number },
): Promise<string> {
  const res = (await client.getComposite(`/templates/${args.template_id}/detail`, {
    hours: args.hours,
  })) as ApiResponse

  const d = res.data as Record<string, unknown>
  const sparkline = (d.sparkline as Array<Record<string, unknown>>) ?? []
  const statusCodes = (d.statusCodes as Array<Record<string, unknown>>) ?? []
  const services = (d.servicesAffected as string[]) ?? []

  let text = `## Template Detail\n\n`
  text += `- Pattern: **${d.templateText}**\n`
  text += `- Services: ${services.join(', ')}\n`
  text += `- Occurrences: ${d.occurrenceCount} (${d.errorCount} errors)\n`
  text += `- Avg duration: ${Number(d.avgDurationMs).toFixed(1)}ms\n`
  text += `- Anomaly score: ${d.maxAnomalyScore}\n`
  text += `- First seen: ${d.firstSeen}\n`
  text += `- Last seen: ${d.lastSeen}\n`

  if (statusCodes.length > 0) {
    text += `\n### Status Codes\n`
    for (const sc of statusCodes) {
      text += `- ${sc.statusCode}: ${sc.count} occurrences\n`
    }
  }

  if (sparkline.length > 0) {
    const counts = sparkline.map((s) => s.count as number)
    const total = counts.reduce((a, b) => a + b, 0)
    const max = Math.max(...counts)
    const min = Math.min(...counts)
    const avg = total / counts.length

    // Determine trend direction from first vs last third
    const third = Math.max(1, Math.floor(counts.length / 3))
    const firstThirdAvg = counts.slice(0, third).reduce((a, b) => a + b, 0) / third
    const lastThirdAvg = counts.slice(-third).reduce((a, b) => a + b, 0) / third
    const trendDir = lastThirdAvg > firstThirdAvg * 1.2 ? 'trending UP' :
      lastThirdAvg < firstThirdAvg * 0.8 ? 'trending DOWN' : 'stable'

    text += `\n### Occurrence Trend (${sparkline.length} intervals)\n`
    text += `- Direction: ${trendDir}\n`
    text += `- Range: ${min}–${max} per interval (avg ${avg.toFixed(1)})\n`
    text += `- Latest: ${sparkline[sparkline.length - 1].intervalStart}: ${sparkline[sparkline.length - 1].count}\n`
    text += `- Peak: ${sparkline[counts.indexOf(max)].intervalStart}: ${max}\n`
  }

  text += formatMeta(res.meta)
  return text
}

async function searchTemplates(
  client: LogWeaveClient,
  args: { query: string; hours?: number; limit?: number; mode?: string },
): Promise<string> {
  const res = (await client.get('/templates/search', {
    q: args.query,
    hours: args.hours,
    limit: args.limit,
    mode: args.mode,
  })) as ApiResponse

  const rows = (res.data as Array<Record<string, unknown>>) ?? []
  const modeLabel = args.mode === 'semantic' ? ' (semantic)' : ''

  if (rows.length === 0) {
    return `No templates matching "${args.query}"${modeLabel} found.${formatMeta(res.meta)}`
  }

  let text = `## Search Results for "${args.query}"${modeLabel} (${rows.length} matches)\n\n`
  for (const r of rows) {
    const services = (r.servicesAffected as string[]).join(', ')
    text += `- **${r.templateText}** [id: ${r.templateId}] — ${r.occurrenceCount} occurrences (${services})\n`
  }

  text += formatMeta(res.meta)
  return text
}

async function templateTrend(
  client: LogWeaveClient,
  args: { template_id: string; days?: number },
): Promise<string> {
  const res = (await client.get(`/templates/${encodeURIComponent(args.template_id)}/trend`, {
    days: args.days,
  })) as ApiResponse

  const rows = (res.data as Array<Record<string, unknown>>) ?? []

  if (rows.length === 0) {
    return `No trend data available for this template.${formatMeta(res.meta)}`
  }

  const counts = rows.map((r) => r.occurrenceCount as number)
  const total = counts.reduce((a, b) => a + b, 0)
  const avg = total / counts.length
  const max = Math.max(...counts)
  const maxDay = rows[counts.indexOf(max)]

  const third = Math.max(1, Math.floor(counts.length / 3))
  const firstAvg = counts.slice(0, third).reduce((a, b) => a + b, 0) / third
  const lastAvg = counts.slice(-third).reduce((a, b) => a + b, 0) / third
  const direction = lastAvg > firstAvg * 1.2 ? 'increasing' : lastAvg < firstAvg * 0.8 ? 'decreasing' : 'stable'

  let text = `## Long-Term Trend (${rows.length} days)\n\n`
  text += `- Direction: **${direction}**\n`
  text += `- Average daily: ${avg.toFixed(0)} occurrences\n`
  text += `- Peak: ${maxDay?.day} — ${max} occurrences\n`
  text += `- First period avg: ${firstAvg.toFixed(0)}/day\n`
  text += `- Recent period avg: ${lastAvg.toFixed(0)}/day`
  if (direction !== 'stable' && firstAvg > 0) {
    const pctChange = (((lastAvg - firstAvg) / firstAvg) * 100).toFixed(0)
    text += ` (${pctChange}%)`
  }
  text += '\n'

  text += formatMeta(res.meta)
  return text
}

async function templateEvents(
  client: LogWeaveClient,
  args: { template_id: string; status_code?: number; hours?: number; limit?: number },
): Promise<string> {
  const res = (await client.get(`/templates/${encodeURIComponent(args.template_id)}/events`, {
    hours: args.hours,
    statusCode: args.status_code,
    limit: args.limit,
  })) as ApiResponse

  const rows = (res.data as Array<Record<string, unknown>>) ?? []

  if (rows.length === 0) {
    const filter = args.status_code ? ` with status ${args.status_code}` : ''
    return `No events found for this template${filter}.${formatMeta(res.meta)}`
  }

  const filter = args.status_code ? ` (status ${args.status_code})` : ''
  let text = `## Template Events${filter} (${rows.length} results)\n\n`
  text += `| Timestamp | Service | Route | Status | Duration | Trace ID |\n`
  text += `|-----------|---------|-------|--------|----------|----------|\n`
  for (const r of rows) {
    const ts = (r.timestamp as string).slice(0, 19).replace('T', ' ')
    const route = (r.route as string) || '-'
    const status = r.statusCode || '-'
    const dur = r.durationMs ? `${r.durationMs}ms` : '-'
    const trace = (r.traceId as string) || '-'
    text += `| ${ts} | ${r.service} | ${route} | ${status} | ${dur} | ${trace} |\n`
  }

  text += formatMeta(res.meta)
  return text
}

async function searchByTag(
  client: LogWeaveClient,
  args: { key: string; value: string; hours?: number; limit?: number },
): Promise<string> {
  const res = (await client.get('/events/by-tag', {
    key: args.key,
    value: args.value,
    hours: args.hours,
    limit: args.limit,
  })) as ApiResponse

  const events = (res.data as Array<Record<string, unknown>>) ?? []

  if (events.length === 0) {
    return (
      `No events found with ${args.key} = "${args.value}" in the last ${args.hours ?? 24} hours.\n\n` +
      `This can mean: (a) no events matched, or (b) tag extraction for "${args.key}" is not configured. ` +
      `Check Settings → Tag Extraction to confirm the tag is set up.`
    )
  }

  let text = `## Events with ${args.key} = "${args.value}" (${events.length} results)\n\n`
  for (const e of events) {
    const ts = (e.timestamp as string).slice(0, 19).replace('T', ' ')
    text += `- **${ts}** ${e.service} [${e.level}] template: ${e.templateId}\n`
  }

  text += formatMeta(res.meta)
  return text
}

export function registerPatterns(server: McpServer, client: LogWeaveClient): void {
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
      errorPatterns(client, args as { hours?: number; service?: string; limit?: number }),
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
      templateDetail(client, args as { template_id: string; hours?: number }),
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
      searchTemplates(client, args as { query: string; hours?: number; limit?: number; mode?: string }),
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
      templateTrend(client, args as { template_id: string; days?: number }),
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
      templateEvents(
        client,
        args as { template_id: string; status_code?: number; hours?: number; limit?: number },
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
      searchByTag(
        client,
        args as { key: string; value: string; hours?: number; limit?: number },
      ),
    ),
  )
}
