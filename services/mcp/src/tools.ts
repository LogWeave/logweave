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
    text += `\n### Occurrence Trend (${sparkline.length} intervals)\n`
    const recent = sparkline.slice(-5)
    for (const s of recent) {
      text += `- ${s.intervalStart}: ${s.count}\n`
    }
    if (sparkline.length > 5) {
      text += `  (showing last 5 of ${sparkline.length} intervals)\n`
    }
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
    text += `\n### Volume Trend (${trend.length} intervals)\n`
    const recent = trend.slice(-5)
    for (const t of recent) {
      text += `- ${t.intervalStart}: ${t.logCount} logs, ${t.errorCount} errors\n`
    }
    if (trend.length > 5) {
      text += `  (showing last 5 of ${trend.length} intervals)\n`
    }
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
