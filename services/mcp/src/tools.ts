import type { LogWeaveClient } from './client.js'
import { type ApiResponse, formatMeta } from './shared/handler.js'

// ---------------------------------------------------------------------------
// Correlation & analysis tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Raw log drill-down
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// New tools from gap analysis (#113)
// ---------------------------------------------------------------------------

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
