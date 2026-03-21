import type { LogWeaveClient } from './client.js'

/**
 * Tool handler functions — each maps to one LogWeave API endpoint.
 * Returns formatted text for LLM consumption.
 */

interface ApiResponse {
  data: unknown
  meta: Record<string, unknown>
}

function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = []
  if (meta.timeRange) parts.push(`Time range: ${meta.timeRange}`)
  if (meta.dataRetention) parts.push(`Data retention: ${meta.dataRetention}`)
  if (meta.message) parts.push(`Note: ${meta.message}`)
  return parts.length > 0 ? `\n\n---\n${parts.join('\n')}` : ''
}

export async function logweaveOverview(
  client: LogWeaveClient,
  args: { hours?: number },
): Promise<string> {
  const res = (await client.getComposite('/overview', {
    hours: args.hours,
  })) as ApiResponse

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
      text += `- **${p.templateText}** — ${p.occurrenceCount} occurrences (${services})\n`
    }
  }

  text += formatMeta(res.meta)
  return text
}

export async function logweaveErrorPatterns(
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
    text += `- **${r.templateText}**${badge}\n`
    text += `  Service: ${r.service} | Count: ${r.occurrenceCount} | Errors: ${r.errorCount}\n`
  }

  text += formatMeta(res.meta)
  return text
}

export async function logweaveChanges(
  client: LogWeaveClient,
  args: { hours?: number; service?: string; since?: string; deploy_id?: string },
): Promise<string> {
  const res = (await client.get('/dashboard/changes', {
    hours: args.hours,
    service: args.service,
    since: args.since,
    deploy_id: args.deploy_id,
  })) as ApiResponse

  const events = (res.data as Array<Record<string, unknown>>) ?? []

  if (events.length === 0) {
    return `No changes detected.${formatMeta(res.meta)}`
  }

  const newEvents = events.filter((e) => e.type === 'new')
  const spikes = events.filter((e) => e.type === 'spike')
  const resolved = events.filter((e) => e.type === 'resolved')

  let text = `## Changes Detected\n\n`

  if (newEvents.length > 0) {
    text += `### New Patterns (${newEvents.length})\n`
    for (const e of newEvents) {
      text += `- **${e.templateText}** — ${e.currentCount} occurrences in ${e.service}\n`
    }
    text += '\n'
  }

  if (spikes.length > 0) {
    text += `### Spikes (${spikes.length})\n`
    for (const e of spikes) {
      text += `- **${e.templateText}** — ${e.ratio}x normal (${e.currentCount} vs ${e.previousCount}) in ${e.service}\n`
    }
    text += '\n'
  }

  if (resolved.length > 0) {
    text += `### Resolved (${resolved.length})\n`
    for (const e of resolved) {
      text += `- **${e.templateText}** — was ${e.previousCount} occurrences in ${e.service}\n`
    }
  }

  text += formatMeta(res.meta)
  return text
}

export async function logweaveTemplateDetail(
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

export async function logweaveServiceHealth(
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
    const trendDir = lastThirdAvg > firstThirdAvg * 1.2 ? 'volume trending UP' :
      lastThirdAvg < firstThirdAvg * 0.8 ? 'volume trending DOWN' : 'volume stable'

    text += `\n### Volume Trend (${trend.length} intervals)\n`
    text += `- Direction: ${trendDir}\n`
    text += `- Total: ${totalLogs} logs, ${totalErrors} errors\n`
    text += `- Peak volume: ${maxLogs} logs/interval, peak errors: ${maxErrors}/interval\n`
    text += `- Latest: ${trend[trend.length - 1].intervalStart}: ${trend[trend.length - 1].logCount} logs, ${trend[trend.length - 1].errorCount} errors\n`
  }

  text += formatMeta(res.meta)
  return text
}

export async function logweaveSearchTemplates(
  client: LogWeaveClient,
  args: { query: string; hours?: number; limit?: number },
): Promise<string> {
  const res = (await client.get('/templates/search', {
    q: args.query,
    hours: args.hours,
    limit: args.limit,
  })) as ApiResponse

  const rows = (res.data as Array<Record<string, unknown>>) ?? []

  if (rows.length === 0) {
    return `No templates matching "${args.query}" found.${formatMeta(res.meta)}`
  }

  let text = `## Search Results for "${args.query}" (${rows.length} matches)\n\n`
  for (const r of rows) {
    const services = (r.servicesAffected as string[]).join(', ')
    text += `- **${r.templateText}** — ${r.occurrenceCount} occurrences (${services})\n`
  }

  text += formatMeta(res.meta)
  return text
}

export async function logweaveDeploys(
  client: LogWeaveClient,
  args: { service?: string; limit?: number },
): Promise<string> {
  const res = (await client.get('/deploys', {
    service: args.service,
    limit: args.limit,
  })) as ApiResponse

  const deploys = (res.data as Array<Record<string, unknown>>) ?? []

  if (deploys.length === 0) {
    return 'No deployments recorded.'
  }

  let text = `## Recent Deployments (${deploys.length})\n\n`
  for (const d of deploys) {
    const version = d.version ? ` v${d.version}` : ''
    const sha = d.commitSha ? ` (${(d.commitSha as string).slice(0, 7)})` : ''
    text += `- **${d.service}**${version}${sha} — ${d.timestamp}\n`
    text += `  Deploy ID: ${d.deployId}\n`
  }

  return text
}

// ---------------------------------------------------------------------------
// Correlation & analysis tools
// ---------------------------------------------------------------------------

export async function logweaveTraceDetails(
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

export async function logweaveRelatedPatterns(
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

export async function logweaveCorrelations(
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

export async function logweaveServiceOutlier(
  client: LogWeaveClient,
  args: { service: string; hours?: number },
): Promise<string> {
  const res = (await client.get(`/services/${encodeURIComponent(args.service)}/outlier`, {
    hours: args.hours,
  })) as ApiResponse

  const d = res.data as Record<string, unknown>

  const verdictLabel = d.verdict === 'outlier' ? '**OUTLIER**' :
    d.verdict === 'elevated' ? '**ELEVATED**' : 'Normal'

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

// ---------------------------------------------------------------------------
// Raw log drill-down
// ---------------------------------------------------------------------------

export async function logweaveRawLogs(
  client: LogWeaveClient,
  args: { template_id: string; service: string; hours?: number; limit?: number },
): Promise<string> {
  const res = (await client.get(
    `/templates/${encodeURIComponent(args.template_id)}/raw-logs`,
    {
      service: args.service,
      hours: args.hours,
      limit: args.limit,
    },
  )) as ApiResponse

  const d = res.data as Record<string, unknown>
  const lines = (d.lines as Array<Record<string, unknown>>) ?? []

  if (lines.length === 0) {
    const msg = res.meta.message
      ? String(res.meta.message)
      : 'No matching raw log lines found.'
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

// ---------------------------------------------------------------------------
// Live tail
// ---------------------------------------------------------------------------

export async function logweaveLiveTail(
  client: LogWeaveClient,
  args: {
    service?: string
    level?: string
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
    template_id: args.template_id,
    min_anomaly: args.min_anomaly,
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
