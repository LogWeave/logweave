import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LogWeaveClient } from '../client.js'
import { type ApiResponse, READ_ONLY, formatMeta, toolHandler } from '../shared/handler.js'
import { buildSystemNotes, formatSystemStateBlock, getAnomalyState } from '../shared/system-state.js'

async function changes(
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

  const changesMeta = res.meta as {
    baselineStatus?: 'empty' | 'sparse' | 'ok'
    previousWindowEvents?: number
    tenantFirstSeenAt?: string | null
  }
  const anomalyState = await getAnomalyState(client)
  const systemBlock = formatSystemStateBlock(buildSystemNotes(anomalyState, changesMeta))

  if (newEvents.length === 0 && spikes.length === 0 && resolved.length === 0) {
    return `No changes detected.${formatMeta(res.meta)}${systemBlock}`
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
  text += systemBlock
  return text
}

async function deploys(
  client: LogWeaveClient,
  args: { service?: string; limit?: number },
): Promise<string> {
  const res = (await client.get('/deploys', {
    service: args.service,
    limit: args.limit,
  })) as ApiResponse

  const deployList = (res.data as Array<Record<string, unknown>>) ?? []

  if (deployList.length === 0) {
    return 'No deployments recorded.'
  }

  let text = `## Recent Deployments (${deployList.length})\n\n`
  for (const d of deployList) {
    const version = d.version ? ` v${d.version}` : ''
    const sha = d.commitSha ? ` (${(d.commitSha as string).slice(0, 7)})` : ''
    text += `- **${d.service}**${version}${sha} — ${d.timestamp}\n`
    text += `  Deploy ID: ${d.deployId}\n`
  }

  return text
}

async function diagnoseService(
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

  // Self-aware system-state block. INSUFFICIENT_DATA verdicts during warmup
  // are easily misread as "system is healthy" by an LLM agent. The block
  // explicitly says "we cannot tell yet" so the LLM relays the right thing
  // to the user.
  const diagnoseAnomalyState = await getAnomalyState(client)
  const diagnoseChangesMeta = (changesRes.meta as {
    baselineStatus?: 'empty' | 'sparse' | 'ok'
    previousWindowEvents?: number
    tenantFirstSeenAt?: string | null
  }) ?? {}
  text += formatSystemStateBlock(buildSystemNotes(diagnoseAnomalyState, diagnoseChangesMeta))

  return text
}

export function registerChanges(server: McpServer, client: LogWeaveClient): void {
  server.registerTool(
    'changes',
    {
      title: 'Recent Changes',
      description:
        'See what changed recently: new error patterns, spiking patterns, and resolved patterns. ' +
        'Anchor to a deploy using since (ISO8601 timestamp) or deploy_id from deploys tool. ' +
        'Use this after deploys or to understand what is different from normal. ' +
        'Do not use for listing all errors — use error_patterns instead.',
      inputSchema: {
        hours: z.number().optional().describe('Time window in hours (default: 24). Ignored if since or deploy_id is set.'),
        service: z.string().optional().describe('Filter to a specific service name'),
        since: z.string().optional().describe('ISO8601 timestamp to anchor comparison (e.g. deploy time)'),
        deploy_id: z.string().optional().describe('Deploy ID from logweave_deploys to anchor comparison'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      changes(client, args as { hours?: number; service?: string; since?: string; deploy_id?: string }),
    ),
  )

  server.registerTool(
    'deploys',
    {
      title: 'Recent Deployments',
      description:
        'List recent deployments. Use this to find deploy IDs and timestamps for anchoring changes queries. ' +
        'Returns service name, version, commit SHA, and timestamp.',
      inputSchema: {
        service: z.string().optional().describe('Filter to a specific service name'),
        limit: z.number().optional().describe('Max results to return (default: 10)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      deploys(client, args as { service?: string; limit?: number }),
    ),
  )

  server.registerTool(
    'diagnose_service',
    {
      title: 'Diagnose Service',
      description:
        'Full diagnostic report for a service: health metrics, outlier detection (z-score), ' +
        'and recent changes (new/spiking/resolved patterns). Combines service_health + service_outlier + changes ' +
        'into a single call. Use this when investigating why a specific service is having problems.',
      inputSchema: {
        service: z.string().describe('Service name (use list_services to discover names)'),
        hours: z.number().optional().describe('Time window in hours (default: 24)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      diagnoseService(client, args as { service: string; hours?: number }),
    ),
  )
}
