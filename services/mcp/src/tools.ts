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
      text += `- **${p.templateText}** [id: ${p.templateId}] — ${p.occurrenceCount} occurrences (${services})\n`
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
    text += `- **${r.templateText}** [id: ${r.templateId}]${badge}\n`
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

  const data = res.data as {
    new: Array<Record<string, unknown>>
    spike: Array<Record<string, unknown>>
    resolved: Array<Record<string, unknown>>
  }

  const newEvents = data.new ?? []
  const spikes = data.spike ?? []
  const resolved = data.resolved ?? []

  if (newEvents.length === 0 && spikes.length === 0 && resolved.length === 0) {
    return `No changes detected.${formatMeta(res.meta)}`
  }

  let text = `## Changes Detected\n\n`

  if (newEvents.length > 0) {
    text += `### New Patterns (${newEvents.length})\n`
    for (const e of newEvents) {
      text += `- **${e.templateText}** [id: ${e.templateId}] — ${e.currentCount} occurrences in ${e.service}\n`
    }
    text += '\n'
  }

  if (spikes.length > 0) {
    text += `### Spikes (${spikes.length})\n`
    for (const e of spikes) {
      text += `- **${e.templateText}** [id: ${e.templateId}] — ${e.ratio}x normal (${e.currentCount} vs ${e.previousCount}) in ${e.service}\n`
    }
    text += '\n'
  }

  if (resolved.length > 0) {
    text += `### Resolved (${resolved.length})\n`
    for (const e of resolved) {
      text += `- **${e.templateText}** [id: ${e.templateId}] — was ${e.previousCount} occurrences in ${e.service}\n`
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
    min_level: args.min_level,
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

// ---------------------------------------------------------------------------
// New tools from gap analysis (#113)
// ---------------------------------------------------------------------------

export async function logweaveListServices(
  client: LogWeaveClient,
  args: { hours?: number },
): Promise<string> {
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

export async function logweaveDiagnoseService(
  client: LogWeaveClient,
  args: { service: string; hours?: number },
): Promise<string> {
  const [healthRes, outlierRes, changesRes] = await Promise.all([
    client.getComposite(`/services/${encodeURIComponent(args.service)}/health`, {
      hours: args.hours,
    }) as Promise<ApiResponse>,
    client.get(`/services/${encodeURIComponent(args.service)}/outlier`, {
      hours: args.hours,
    }) as Promise<ApiResponse>,
    client.get('/dashboard/changes', {
      hours: args.hours,
      service: args.service,
    }) as Promise<ApiResponse>,
  ])

  const health = healthRes.data as Record<string, unknown>
  const outlier = outlierRes.data as Record<string, unknown>
  const changes = changesRes.data as { new?: Array<Record<string, unknown>>; spike?: Array<Record<string, unknown>>; resolved?: Array<Record<string, unknown>> }

  let text = `## Diagnostic: ${args.service}\n\n`

  // Outlier status
  text += `### Status: ${(outlier.verdict as string).toUpperCase()}`
  if (outlier.zScore != null) {
    text += ` (z-score: ${(outlier.zScore as number).toFixed(1)})`
  }
  text += '\n'
  if (outlier.currentRate != null) {
    text += `Current error rate: ${outlier.currentRate} (baseline: ${outlier.baselineMean}, stddev: ${outlier.baselineStddev})\n`
  }

  // Health metrics
  text += `\n### Health\n`
  text += `- Log volume: ${health.logCount}\n`
  text += `- Errors: ${health.errorCount} (${((health.errorRate as number) * 100).toFixed(1)}%)\n`
  text += `- Warnings: ${health.warnCount} (${((health.warnRate as number) * 100).toFixed(1)}%)\n`

  // Top error patterns
  const patterns = (health.topErrorPatterns as Array<Record<string, unknown>>) ?? []
  if (patterns.length > 0) {
    text += `\n### Top Error Patterns\n`
    for (const p of patterns) {
      text += `- **${p.templateText}** [id: ${p.templateId}] — ${p.occurrenceCount} occurrences\n`
    }
  }

  // Changes
  const newEvents = changes.new ?? []
  const spikes = changes.spike ?? []
  const resolved = changes.resolved ?? []
  if (newEvents.length > 0 || spikes.length > 0 || resolved.length > 0) {
    text += `\n### Recent Changes\n`
    if (newEvents.length > 0) {
      text += `New patterns (${newEvents.length}):\n`
      for (const e of newEvents) {
        text += `- **${e.templateText}** [id: ${e.templateId}] — ${e.currentCount} occurrences\n`
      }
    }
    if (spikes.length > 0) {
      text += `Spikes (${spikes.length}):\n`
      for (const e of spikes) {
        text += `- **${e.templateText}** [id: ${e.templateId}] — ${e.ratio}x normal\n`
      }
    }
    if (resolved.length > 0) {
      text += `Resolved (${resolved.length}):\n`
      for (const e of resolved) {
        text += `- **${e.templateText}** [id: ${e.templateId}]\n`
      }
    }
  }

  text += formatMeta(healthRes.meta)
  return text
}

export async function logweaveTemplateTrend(
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

export async function logweaveLevelDistribution(
  client: LogWeaveClient,
  args: { hours?: number; service?: string },
): Promise<string> {
  const res = (await client.get('/dashboard/levels', {
    hours: args.hours,
    service: args.service,
  })) as ApiResponse

  const rows = (res.data as Array<Record<string, unknown>>) ?? []

  if (rows.length === 0) {
    return `No level data found.${formatMeta(res.meta)}`
  }

  const total = rows.reduce((sum, r) => sum + (r.count as number), 0)

  let text = `## Level Distribution${args.service ? ` (${args.service})` : ''}\n\n`
  for (const r of rows) {
    const pct = (((r.count as number) / total) * 100).toFixed(1)
    text += `- ${r.level}: ${(r.count as number).toLocaleString()} (${pct}%)\n`
  }
  text += `\nTotal: ${total.toLocaleString()}\n`

  text += formatMeta(res.meta)
  return text
}

export async function logweaveTemplateEvents(
  client: LogWeaveClient,
  args: { template_id: string; status_code?: number; hours?: number; limit?: number },
): Promise<string> {
  const res = (await client.get(`/templates/${encodeURIComponent(args.template_id)}/events`, {
    hours: args.hours,
    status_code: args.status_code,
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

// ---------------------------------------------------------------------------
// Tag search tools
// ---------------------------------------------------------------------------

export async function logweaveSearchByTag(
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
    return `No events found with ${args.key} = "${args.value}" in the last ${args.hours ?? 24} hours.`
  }

  let text = `## Events with ${args.key} = "${args.value}" (${events.length} results)\n\n`
  for (const e of events) {
    const ts = (e.timestamp as string).slice(0, 19).replace('T', ' ')
    text += `- **${ts}** ${e.service} [${e.level}] template: ${e.templateId}\n`
  }

  text += formatMeta(res.meta)
  return text
}

// ---------------------------------------------------------------------------
// Alert rules + history tools
// ---------------------------------------------------------------------------

export async function logweaveListRules(client: LogWeaveClient): Promise<string> {
  const res = (await client.get('/rules')) as ApiResponse
  const rules = (res.data as Array<Record<string, unknown>>) ?? []

  if (rules.length === 0) {
    return 'No alert rules configured.'
  }

  let text = `## Alert Rules (${rules.length})\n\n`
  for (const r of rules) {
    const status = r.enabled ? 'enabled' : 'disabled'
    const type = r.ruleType === 'threshold' ? 'threshold' : 'template_watch'
    text += `### ${r.name} [${status}]\n`
    text += `- Type: ${type}\n`
    text += `- Rule ID: ${r.ruleId}\n`

    const config = r.config as Record<string, unknown>
    if (r.ruleType === 'threshold') {
      text += `- Condition: ${config.service} ${config.metric} ${config.operator} ${config.value} (${config.windowMinutes}min window)\n`
    } else {
      text += `- Template: ${config.templateText} [id: ${config.templateId}]\n`
    }

    const channels = (r.channels as string[]) ?? []
    if (channels.length > 0) {
      text += `- Channels: ${channels.length} webhook(s)\n`
    } else {
      text += `- Channels: tenant default\n`
    }
    text += '\n'
  }

  return text
}

export async function logweaveCreateRule(
  client: LogWeaveClient,
  args: {
    name: string
    rule_type?: string
    metric?: string
    service?: string
    operator?: string
    value?: number
    window_minutes?: number
    template_id?: string
    template_text?: string
    channels?: string[]
  },
): Promise<string> {
  const ruleType = args.rule_type === 'template_watch' ? 'template_watch' : 'threshold'

  if (ruleType === 'template_watch') {
    if (!args.template_id) return 'Error: template_id is required for template_watch rules. Get the ID from error_patterns or search_templates.'
    if (!args.template_text) return 'Error: template_text is required for template_watch rules. Copy the pattern text from the pattern listing.'

    const body = {
      name: args.name,
      ruleType: 'template_watch',
      config: { templateId: args.template_id, templateText: args.template_text },
      channels: args.channels ?? [],
    }
    const res = (await client.post('/rules', body)) as ApiResponse
    const rule = res.data as Record<string, unknown>

    let text = `## Rule Created\n\n`
    text += `- Name: ${rule.name}\n`
    text += `- Rule ID: ${rule.ruleId}\n`
    text += `- Type: template_watch\n`
    text += `- Pattern: ${args.template_text}\n`
    text += `- Enabled: ${rule.enabled}\n`
    const channels = (rule.channels as string[]) ?? []
    text += `- Channels: ${channels.length > 0 ? `${channels.length} webhook(s)` : 'tenant default'}\n`
    return text
  }

  // threshold rule
  if (!args.metric) return 'Error: metric is required for threshold rules.'
  if (!args.service) return 'Error: service is required for threshold rules.'
  if (!args.operator) return 'Error: operator is required for threshold rules.'
  if (args.value === undefined) return 'Error: value is required for threshold rules.'
  if (!args.window_minutes) return 'Error: window_minutes is required for threshold rules.'

  const body = {
    name: args.name,
    ruleType: 'threshold',
    config: {
      metric: args.metric,
      service: args.service,
      operator: args.operator,
      value: args.value,
      windowMinutes: args.window_minutes,
    },
    channels: args.channels ?? [],
  }

  const res = (await client.post('/rules', body)) as ApiResponse
  const rule = res.data as Record<string, unknown>

  let text = `## Rule Created\n\n`
  text += `- Name: ${rule.name}\n`
  text += `- Rule ID: ${rule.ruleId}\n`
  text += `- Type: threshold\n`
  text += `- Condition: ${args.service} ${args.metric} ${args.operator} ${args.value} (${args.window_minutes}min window)\n`
  text += `- Enabled: ${rule.enabled}\n`

  const channels = (rule.channels as string[]) ?? []
  text += `- Channels: ${channels.length > 0 ? `${channels.length} webhook(s)` : 'tenant default'}\n`

  return text
}

export async function logweaveListAlerts(
  client: LogWeaveClient,
  args: { hours?: number; rule_id?: string; service?: string; limit?: number },
): Promise<string> {
  const res = (await client.get('/alerts', {
    hours: args.hours,
    rule_id: args.rule_id,
    service: args.service,
    limit: args.limit,
  })) as ApiResponse

  const alerts = (res.data as Array<Record<string, unknown>>) ?? []
  const hours = (res.meta.hours as number) ?? args.hours ?? 24

  if (alerts.length === 0) {
    return `No alerts fired in the last ${hours} hours.`
  }

  let text = `## Alert History (${alerts.length} alerts, last ${hours}h)\n\n`
  for (const a of alerts) {
    const ts = (a.firedAt as string).slice(0, 19).replace('T', ' ')
    const details = (a.details as Record<string, unknown>) ?? {}
    const service = (details.service as string) ?? 'unknown'

    text += `### ${a.ruleName} — ${ts}\n`
    text += `- Type: ${a.ruleType}\n`
    text += `- Service: ${service}\n`

    if (a.ruleType === 'threshold' || a.ruleType === 'threshold_breach') {
      text += `- Value: ${a.metricValue} (threshold: ${a.thresholdValue})\n`
      if (details.metric) text += `- Metric: ${details.metric} ${details.operator} ${a.thresholdValue} (${details.windowMinutes}min)\n`
    } else {
      text += `- Anomaly score: ${a.metricValue}\n`
    }

    const channels = (a.channelsNotified as string[]) ?? []
    if (channels.length > 0) {
      text += `- Notified: ${channels.length} channel(s)\n`
    }
    text += '\n'
  }

  return text
}

// ---------------------------------------------------------------------------
// Incident post-mortem assistant
// ---------------------------------------------------------------------------

export async function logweaveIncidentPostmortem(
  client: LogWeaveClient,
  args: { service: string; since?: string; hours?: number },
): Promise<string> {
  const hours = args.hours ?? 2

  const [deploysRes, changesRes, outlierRes, patternsRes] = await Promise.all([
    client.get('/deploys', { service: args.service, limit: 5 }) as Promise<ApiResponse>,
    client.get('/dashboard/changes', {
      service: args.service,
      since: args.since,
      hours,
    }) as Promise<ApiResponse>,
    client.get(`/services/${encodeURIComponent(args.service)}/outlier`, {
      hours,
    }) as Promise<ApiResponse>,
    client.get('/dashboard/templates', {
      service: args.service,
      hours,
      level: 'ERROR',
      limit: 10,
    }) as Promise<ApiResponse>,
  ])

  const deploys = (deploysRes.data as Array<Record<string, unknown>>) ?? []
  const changes = changesRes.data as {
    new?: Array<Record<string, unknown>>
    spike?: Array<Record<string, unknown>>
    resolved?: Array<Record<string, unknown>>
  }
  const outlier = outlierRes.data as Record<string, unknown>
  const patterns = (patternsRes.data as Array<Record<string, unknown>>) ?? []

  // Phase 2: correlations for the top error pattern (best-effort)
  let correlations: Array<Record<string, unknown>> = []
  const topPattern = patterns[0]
  if (topPattern?.templateId) {
    try {
      const corrRes = (await client.get(
        `/templates/${encodeURIComponent(topPattern.templateId as string)}/correlations`,
        { hours },
      )) as ApiResponse
      correlations = (corrRes.data as Array<Record<string, unknown>>) ?? []
    } catch {
      // correlations are best-effort — don't fail the whole post-mortem
    }
  }

  const windowStart = args.since ?? new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  const windowEnd = new Date().toISOString()
  const triggerDeploy = deploys[0] as Record<string, unknown> | undefined

  const newPatterns = changes.new ?? []
  const spikes = changes.spike ?? []
  const resolved = changes.resolved ?? []

  const correlatedServiceNames = [...new Set(correlations.map((c) => c.service as string).filter(Boolean))]
  const blastRadius = correlatedServiceNames.length + 1

  let text = `## Incident Post-Mortem: ${args.service}\n\n`

  text += `### Summary\n\n`
  text += `- **Service:** ${args.service}\n`
  text += `- **Window:** ${windowStart.slice(0, 19).replace('T', ' ')} → ${windowEnd.slice(0, 19).replace('T', ' ')} UTC\n`
  text += `- **Status:** ${((outlier.verdict as string) ?? 'unknown').toUpperCase()}`
  if (outlier.zScore != null) text += ` (z-score: ${(outlier.zScore as number).toFixed(1)})`
  text += '\n'
  text += `- **Error rate:** ${outlier.currentRate ?? 'n/a'} (baseline: ${outlier.baselineMean ?? 'n/a'})\n`
  if (triggerDeploy) {
    const version = triggerDeploy.version ? ` v${triggerDeploy.version}` : ''
    const ts = (triggerDeploy.timestamp as string).slice(0, 19).replace('T', ' ')
    text += `- **Trigger:** Deploy${version} at ${ts} UTC\n`
  }
  text += `- **Blast radius:** ${blastRadius} service${blastRadius !== 1 ? 's' : ''} affected\n`

  text += `\n### Timeline\n\n`
  if (triggerDeploy) {
    const version = triggerDeploy.version ? ` v${triggerDeploy.version}` : ''
    const ts = (triggerDeploy.timestamp as string).slice(0, 19).replace('T', ' ')
    text += `- ${ts} — Deploy${version} (${triggerDeploy.service})\n`
  }
  for (const p of newPatterns) {
    text += `- NEW pattern: **"${p.templateText}"** — ${p.currentCount} occurrences\n`
  }
  for (const p of spikes) {
    text += `- SPIKE: **"${p.templateText}"** — ${p.ratio}x normal (${p.currentCount} vs ${p.previousCount})\n`
  }
  if (!triggerDeploy && newPatterns.length === 0 && spikes.length === 0) {
    text += `- No deploys or pattern changes detected in the window.\n`
  }

  if (patterns.length > 0) {
    text += `\n### Patterns Involved\n\n`
    for (const p of patterns) {
      const isNew = newPatterns.some((n) => n.templateId === p.templateId) ? ' [NEW]' : ''
      const isSpike = spikes.some((s) => s.templateId === p.templateId) ? ' [SPIKE]' : ''
      text += `- **${p.templateText}**${isNew}${isSpike} [id: ${p.templateId}] — ${p.occurrenceCount} occurrences\n`
    }
  }

  if (correlations.length > 0) {
    text += `\n### Correlated Services\n\n`
    for (const c of correlations) {
      const dir = c.direction === 'positive' ? '+' : '-'
      text += `- **${c.templateText}** (${c.service}) — r=${c.coefficient} (${dir})\n`
    }
    text += `\nPositive (+) = spikes with ${args.service} errors. Negative (-) = inverse relationship.\n`
  }

  if (resolved.length > 0) {
    text += `\n### Resolved During Window\n\n`
    for (const p of resolved) {
      text += `- ~~${p.templateText}~~ — was ${p.previousCount} occurrences\n`
    }
  }

  return text
}

// ---------------------------------------------------------------------------
// Cost optimization tool
// ---------------------------------------------------------------------------

export async function logweaveCostOptimizer(
  client: LogWeaveClient,
  args: { hours?: number; service?: string },
): Promise<string> {
  const res = (await client.get('/cost/analysis', {
    hours: args.hours,
    service: args.service,
  })) as {
    data: {
      summary: { totalPatternsAnalyzed: number; noiseCount: number; reviewCount: number; keepCount: number; potentialReductionPct: number }
      patterns: Array<{ classification: string; template: string; service: string; volumePct: number; level: string; count: number; suggestion: string }>
      thresholds: { noiseDebugPct: number; reviewInfoPct: number; reviewWarnPct: number }
    }
    meta: Record<string, unknown>
  }

  const { summary, patterns, thresholds } = res.data

  let text = `## Log Cost Analysis\n\n`
  text += `Analyzed ${summary.totalPatternsAnalyzed} patterns: ${summary.noiseCount} noise, ${summary.reviewCount} review, ${summary.keepCount} keep\n\n`
  text += `**Potential volume reduction:** ${summary.potentialReductionPct}%\n\n`
  text += `Thresholds: noise DEBUG/TRACE > ${thresholds.noiseDebugPct}%, review INFO > ${thresholds.reviewInfoPct}%, review WARN > ${thresholds.reviewWarnPct}%\n`

  const noisePatterns = patterns.filter((p) => p.classification === 'noise')
  const reviewPatterns = patterns.filter((p) => p.classification === 'review')

  if (noisePatterns.length > 0) {
    text += `\n### Noise Patterns (consider removing)\n\n`
    for (const p of noisePatterns) {
      text += `- **${p.template}** [${p.service}] — ${p.volumePct}% of volume (${p.level}, ${p.count} events) — ${p.suggestion}\n`
    }
  }

  if (reviewPatterns.length > 0) {
    text += `\n### Review Patterns (consider sampling)\n\n`
    for (const p of reviewPatterns) {
      text += `- **${p.template}** [${p.service}] — ${p.volumePct}% of volume (${p.level}, ${p.count} events) — ${p.suggestion}\n`
    }
  }

  if (noisePatterns.length === 0 && reviewPatterns.length === 0) {
    text += `\nNo optimization suggestions found.\n`
  }

  text += formatMeta(res.meta)
  return text
}
