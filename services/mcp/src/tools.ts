import type { LogWeaveClient } from './client.js'
import { type ApiResponse, formatMeta } from './shared/handler.js'

export async function logweaveChanges(
  client: LogWeaveClient,
  args: { hours?: number; service?: string; since?: string; deploy_id?: string },
): Promise<string> {
  const res = (await client.get('/dashboard/changes', {
    hours: args.hours,
    service: args.service,
    since: args.since,
    deployId: args.deploy_id,
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

// ---------------------------------------------------------------------------
// New tools from gap analysis (#113)
// ---------------------------------------------------------------------------

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
  const diagnoseVerdict = outlier.verdict === 'insufficient_data' ? 'INSUFFICIENT DATA (baseline building)' : (outlier.verdict as string).toUpperCase()
  text += `### Status: ${diagnoseVerdict}`
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
): Promise<string> {
  if (args.rule_type === 'template_watch') {
    if (!args.template_id) return 'Error: template_id is required for template_watch rules. Get the ID from error_patterns or search_templates.'

    const body = {
      name: args.name,
      ruleType: 'template_watch',
      config: {
        templateId: args.template_id,
        ...(args.template_text ? { templateText: args.template_text } : {}),
      },
      channels: args.channels ?? [],
    }
    const res = (await client.post('/rules', body)) as ApiResponse
    const rule = res.data as Record<string, unknown>

    let text = `## Rule Created\n\n`
    text += `- Name: ${rule.name}\n`
    text += `- Rule ID: ${rule.ruleId}\n`
    text += `- Type: template_watch\n`
    text += `- Pattern: ${args.template_text ?? args.template_id}\n`
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
    ruleId: args.rule_id,
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
