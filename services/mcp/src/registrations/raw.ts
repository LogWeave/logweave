import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LogWeaveClient } from '../client.js'
import { type ApiResponse, formatMeta, READ_ONLY, toolHandler } from '../shared/handler.js'

async function rawLogs(
  client: LogWeaveClient,
  args: { template_id: string; service: string; hours?: number; limit?: number },
): Promise<string> {
  const res = (await client.get(`/templates/${encodeURIComponent(args.template_id)}/raw-logs`, {
    service: args.service,
    hours: args.hours,
    limit: args.limit,
  })) as ApiResponse

  const d = res.data as Record<string, unknown>
  const lines = (d.lines as Array<Record<string, unknown>>) ?? []

  if (lines.length === 0) {
    const msg = res.meta.message ? String(res.meta.message) : 'No matching raw log lines found.'
    return `${msg}${formatMeta(res.meta)}`
  }

  let text = `## Raw Log Samples (${lines.length} lines)\n\n`

  for (const line of lines) {
    const ts = line.timestamp ? `**${line.timestamp}** ` : ''
    text += `${ts}\`${line.message}\`\n`
    if (line.sourceUrl) {
      text += `  Source: [${line.source}](${line.sourceUrl})\n`
    } else if (line.source) {
      text += `  Source: ${line.source}\n`
    }
    text += '\n'
  }

  const truncated = d.truncated as boolean
  if (truncated) {
    text += `\n**Note:** Scan was truncated (${d.truncatedReason}). Narrow your time window or service filter for more complete results.\n`
  }

  text += `\nFiles scanned: ${d.filesScanned} | Bytes scanned: ${d.bytesScanned}`
  text += formatMeta(res.meta)
  return text
}

async function liveTail(
  client: LogWeaveClient,
  args: {
    service?: string
    level?: string
    min_level?: string
    template_id?: string
    min_anomaly?: number
    seconds?: number
    limit?: number
    cursor?: number
  },
): Promise<string> {
  const res = (await client.get('/tail/poll', {
    service: args.service,
    level: args.level,
    minLevel: args.min_level,
    templateId: args.template_id,
    minAnomaly: args.min_anomaly,
    seconds: args.seconds,
    limit: args.limit,
    cursor: args.cursor,
  })) as ApiResponse

  const d = res.data as Record<string, unknown>
  const events = (d.events as Array<Record<string, unknown>>) ?? []
  const cursor = d.cursor as number
  const gap = d.gap as boolean | undefined

  if (events.length === 0) {
    const msg = res.meta.message
      ? String(res.meta.message)
      : 'No events in the buffer. Events appear when logs are ingested.'
    return `${msg}\n\nCursor: ${cursor} (use this in your next call)`
  }

  let text = `## Live Events (${events.length})\n\n`

  if (gap) {
    const missed = d.missedEstimate as number
    text += `**Warning:** ~${missed} events were missed since your last poll. Buffer wrapped.\n\n`
  }

  for (const e of events) {
    const anomaly = (e.anomalyScore as number) > 0.5 ? ` [ANOMALY ${e.anomalyScore}]` : ''
    const status = e.statusCode ? ` [${e.statusCode}]` : ''
    const dur = e.durationMs ? ` ${e.durationMs}ms` : ''
    text += `- **${e.timestamp}** ${e.service} ${e.level}${status}${dur}${anomaly}\n`
    text += `  ${e.templateText}\n`
    if (e.preProcessedMessage) {
      text += `  Message: ${e.preProcessedMessage}\n`
    }
  }

  text += `\nCursor: ${cursor} (use this in your next call to get only new events)`
  text += formatMeta(res.meta)
  return text
}

export function registerRaw(server: McpServer, client: LogWeaveClient): void {
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
        service: z
          .string()
          .describe('Service name — required to locate the correct log source path'),
        hours: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .describe('Time window in hours (default: 1, max: 24)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max lines to return (default: 20, max: 100)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      rawLogs(
        client,
        args as { template_id: string; service: string; hours?: number; limit?: number },
      ),
    ),
  )

  server.registerTool(
    'live_tail',
    {
      title: 'Live Event Stream',
      description:
        'Poll the live event buffer to see what is happening right now. Returns recent events ' +
        'from the ingest pipeline. Use cursor from previous calls to get only new events (avoids duplicates). ' +
        'Filter by service, level, template_id, or anomaly score. Live tail is enabled by default; ' +
        'a tenant can disable it. Use this during incident investigation to watch patterns emerge in real-time.',
      inputSchema: {
        service: z.string().optional().describe('Filter to a specific service'),
        level: z.string().optional().describe('Filter to exact log level (e.g. ERROR)'),
        min_level: z
          .string()
          .optional()
          .describe('Minimum severity threshold (e.g. WARN shows WARN+ERROR+FATAL)'),
        template_id: z.string().optional().describe('Filter to a specific template pattern'),
        min_anomaly: z
          .number()
          .min(0)
          .optional()
          .describe('Minimum anomaly score (0 = normal, ≥1.0 = anomalous, no upper bound)'),
        seconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('How far back on first call (default: 30, max: 60)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Max events to return (default: 50, max: 200)'),
        cursor: z
          .number()
          .optional()
          .describe('Sequence number from previous call — get only new events'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      liveTail(
        client,
        args as {
          service?: string
          level?: string
          min_level?: string
          template_id?: string
          min_anomaly?: number
          seconds?: number
          limit?: number
          cursor?: number
        },
      ),
    ),
  )
}
