import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LogWeaveClient } from '../client.js'
import { type ApiResponse, formatMeta, READ_ONLY, toolHandler } from '../shared/handler.js'
import {
  buildSystemNotes,
  formatSystemStateBlock,
  getAnomalyState,
} from '../shared/system-state.js'

async function levelDistribution(
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

async function incidentPostmortem(
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

  const correlatedServiceNames = [
    ...new Set(correlations.map((c) => c.service as string).filter(Boolean)),
  ]
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

  // Self-aware system-state block so an LLM agent reading the postmortem
  // can tell "system says all clear" from "system cannot tell yet".
  const anomalyState = await getAnomalyState(client)
  const changesMeta =
    (changesRes.meta as {
      baselineStatus?: 'empty' | 'sparse' | 'ok'
      previousWindowEvents?: number
      tenantFirstSeenAt?: string | null
    }) ?? {}
  const notes = buildSystemNotes(anomalyState, changesMeta)
  text += formatSystemStateBlock(notes)

  return text
}

async function costOptimizer(
  client: LogWeaveClient,
  args: { hours?: number; service?: string },
): Promise<string> {
  const res = (await client.get('/cost/analysis', {
    hours: args.hours,
    service: args.service,
  })) as {
    data: {
      summary: {
        totalPatternsAnalyzed: number
        noiseCount: number
        reviewCount: number
        keepCount: number
        potentialReductionPct: number
      }
      patterns: Array<{
        classification: string
        template: string
        service: string
        volumePct: number
        level: string
        count: number
        suggestion: string
      }>
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

async function comparePeriods(
  client: LogWeaveClient,
  args: { service?: string; recent_hours?: number; baseline_hours?: number },
): Promise<string> {
  const { service, recent_hours = 2, baseline_hours = 2 } = args

  type TemplateRow = {
    templateId: string
    template: string
    count: number
    errorCount: number
    service: string
  }

  const params: Record<string, string | number | undefined> = { service }

  // Fetch combined window (recent + baseline) and recent window in parallel.
  // Baseline counts are derived as: combined - recent (avoids double-counting the recent period).
  const [combinedData, recentData] = await Promise.all([
    client.get('/dashboard/templates', { ...params, hours: recent_hours + baseline_hours }),
    client.get('/dashboard/templates', { ...params, hours: recent_hours }),
  ])

  const combined = (combinedData as { data: TemplateRow[] }).data ?? []
  const recent = (recentData as { data: TemplateRow[] }).data ?? []

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

  const changed: Array<{
    template: string
    service: string
    recentCount: number
    baselineCount: number
    ratio: number
  }> = []

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
}

export function registerInsights(server: McpServer, client: LogWeaveClient): void {
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
    toolHandler((args) => levelDistribution(client, args as { hours?: number; service?: string })),
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
          .describe(
            'ISO8601 timestamp to start the window from (e.g. deploy time or alert trigger)',
          ),
        hours: z
          .number()
          .optional()
          .describe('Window length in hours (default: 2). Ignored if since is provided.'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      incidentPostmortem(client, args as { service: string; since?: string; hours?: number }),
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
    toolHandler((args) => costOptimizer(client, args as { hours?: number; service?: string })),
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
        baseline_hours: z
          .number()
          .default(2)
          .describe(
            'Baseline period length in hours (default: 2, starts right after recent period)',
          ),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      comparePeriods(
        client,
        args as { service?: string; recent_hours?: number; baseline_hours?: number },
      ),
    ),
  )
}
