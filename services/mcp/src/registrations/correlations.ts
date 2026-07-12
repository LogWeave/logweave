import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LogWeaveClient } from '../client.js'
import { type ApiResponse, formatMeta, READ_ONLY, toolHandler } from '../shared/handler.js'

async function traceDetails(
  client: LogWeaveClient,
  args: { trace_id: string; hours?: number },
): Promise<string> {
  let res: ApiResponse
  try {
    res = (await client.get(`/traces/${encodeURIComponent(args.trace_id)}`, {
      hours: args.hours,
    })) as ApiResponse
  } catch (err) {
    // API returns 404 when trace not found — return friendly message instead of error
    if (err instanceof Error && err.message.includes('(404)')) {
      return `No events found for trace ${args.trace_id} in the specified time window. The trace may have expired (30-day retention) or the trace_id may be incorrect.`
    }
    throw err
  }

  const events = (res.data as Array<Record<string, unknown>>) ?? []

  const services = [...new Set(events.map((e) => e.service as string))]

  let text = `## Trace: ${args.trace_id}\n\n`
  text += `- Events: ${events.length}\n`
  text += `- Services: ${services.join(', ')}\n\n`

  text += `### Event Timeline\n\n`
  for (const e of events) {
    const dur = e.durationMs ? ` (${e.durationMs}ms)` : ''
    const status = e.statusCode ? ` [${e.statusCode}]` : ''
    text += `- **${e.timestamp}** ${e.service} ${e.level}${status}${dur}\n`
    text += `  ${e.templateText}\n`
  }

  text += formatMeta(res.meta)
  return text
}

async function relatedPatterns(
  client: LogWeaveClient,
  args: { template_id: string; hours?: number; limit?: number },
): Promise<string> {
  const res = (await client.get(`/templates/${encodeURIComponent(args.template_id)}/related`, {
    hours: args.hours,
    limit: args.limit,
  })) as ApiResponse

  const patterns = (res.data as Array<Record<string, unknown>>) ?? []

  if (patterns.length === 0) {
    return `No related patterns found for template ${args.template_id}. The template may not have trace_id associations.${formatMeta(res.meta)}`
  }

  let text = `## Related Patterns for ${args.template_id}\n\n`
  text += `Patterns that co-occur in the same request traces (causal correlation):\n\n`

  for (const p of patterns) {
    text += `- **${p.templateText}** — ${p.coOccurrenceCount} co-occurrences\n`
    text += `  Service: ${p.service}\n`
  }

  text += formatMeta(res.meta)
  return text
}

async function correlations(
  client: LogWeaveClient,
  args: { template_id: string; hours?: number; limit?: number },
): Promise<string> {
  const res = (await client.get(`/templates/${encodeURIComponent(args.template_id)}/correlations`, {
    hours: args.hours,
    limit: args.limit,
  })) as ApiResponse

  const rows = (res.data as Array<Record<string, unknown>>) ?? []

  if (rows.length === 0) {
    return `No statistically correlated patterns found for template ${args.template_id} (threshold: r >= 0.7).${formatMeta(res.meta)}`
  }

  let text = `## Statistical Correlations for ${args.template_id}\n\n`
  text += `Pearson correlation of 5-minute occurrence counts (r >= 0.7):\n\n`

  for (const r of rows) {
    const dir = r.direction === 'positive' ? '+' : '-'
    text += `- **${r.templateText}** — r=${r.coefficient} (${dir}) | ${r.occurrenceCount} occurrences\n`
  }

  text += `\nPositive (+) = patterns spike together. Negative (-) = one rises as the other falls.`
  text += formatMeta(res.meta)
  return text
}

async function serviceOutlier(
  client: LogWeaveClient,
  args: { service: string; hours?: number },
): Promise<string> {
  const res = (await client.get(`/services/${encodeURIComponent(args.service)}/outlier`, {
    hours: args.hours,
  })) as ApiResponse

  const d = res.data as Record<string, unknown>

  const verdictLabel =
    d.verdict === 'outlier'
      ? '**OUTLIER**'
      : d.verdict === 'elevated'
        ? '**ELEVATED**'
        : d.verdict === 'insufficient_data'
          ? '**INSUFFICIENT DATA**'
          : 'Normal'

  let text = `## Service Outlier: ${d.service}\n\n`
  text += `- Verdict: ${verdictLabel}\n`
  text += `- Z-score: ${d.zScore}\n`
  text += `- Current error rate: ${d.currentRate} (${d.currentErrors} errors / ${d.currentLogs} logs)\n`
  text += `- Baseline mean: ${d.baselineMean} (stddev: ${d.baselineStddev})\n`
  text += `- Data points: ${d.dataPoints} hourly buckets\n`

  if (d.warning) {
    text += `\n**Warning:** ${d.warning}\n`
  }

  if (d.verdict === 'outlier') {
    text += `\nThis service has significantly more errors than its 7-day baseline. Investigate with error_patterns and changes tools.`
  } else if (d.verdict === 'elevated') {
    text += `\nThis service has somewhat more errors than usual. Monitor closely.`
  }

  text += formatMeta(res.meta)
  return text
}

export function registerCorrelations(server: McpServer, client: LogWeaveClient): void {
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
    toolHandler((args) => traceDetails(client, args as { trace_id: string; hours?: number })),
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
        hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe('Time window in hours (default: 24, max: 720)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max results to return (default: 20, max: 100)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      relatedPatterns(client, args as { template_id: string; hours?: number; limit?: number }),
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
        hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe('Time window in hours (default: 24, max: 720)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max results to return (default: 10, max: 50)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      correlations(client, args as { template_id: string; hours?: number; limit?: number }),
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
        hours: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe('Current window in hours for comparison (default: 1, max: 6)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) => serviceOutlier(client, args as { service: string; hours?: number })),
  )
}
