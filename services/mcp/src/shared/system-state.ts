import type { LogWeaveClient } from '../client.js'

/**
 * Self-awareness block for MCP tool responses.
 *
 * Some MCP responses are technically correct but easily misread by an LLM
 * agent. Examples:
 *   - "diagnose_service" returns 'INSUFFICIENT_DATA' immediately after a
 *     fresh start because the anomaly scorer is still warming up. An LLM
 *     reading just the status will tell its user "everything looks fine"
 *     when the truth is "we cannot tell yet".
 *   - "changes" returns empty arrays when the comparison window is empty
 *     (fresh install, 1h view, only 30 min of data). The LLM will conclude
 *     "nothing has changed" when "we have no baseline" is closer to the truth.
 *
 * This helper makes one call each to the dashboard anomaly-state endpoint and
 * (optionally) the changes endpoint, and returns plain-English notes the tool
 * can append to its markdown output. Empty array if everything is steady.
 */

interface AnomalyState {
  phase: 'unknown' | 'cold-start' | 'warmup' | 'steady'
  warmupRemainingMs: number
}

interface ChangesMeta {
  baselineStatus?: 'empty' | 'sparse' | 'ok'
  previousWindowEvents?: number
  tenantFirstSeenAt?: string | null
}

export async function getAnomalyState(client: LogWeaveClient): Promise<AnomalyState | null> {
  try {
    const res = (await client.get('/dashboard/anomaly-state')) as { data?: AnomalyState }
    return res.data ?? null
  } catch {
    return null
  }
}

/**
 * Build a list of self-aware notes from the anomaly state and (optional)
 * changes meta. Each entry is a single plain-English sentence the tool
 * appends to its markdown output.
 */
export function buildSystemNotes(
  anomalyState: AnomalyState | null,
  changesMeta?: ChangesMeta | null,
): string[] {
  const notes: string[] = []

  if (anomalyState) {
    if (anomalyState.phase === 'cold-start') {
      const min = Math.ceil(anomalyState.warmupRemainingMs / 60_000)
      notes.push(
        `Anomaly scorer is in cold-start: anomaly scores will be 0 for ~${min} more minute(s). Treat 'INSUFFICIENT_DATA' verdicts as "we cannot tell yet" rather than "system is healthy".`,
      )
    } else if (anomalyState.phase === 'warmup') {
      const min = Math.ceil(anomalyState.warmupRemainingMs / 60_000)
      notes.push(
        `Anomaly scorer is warming up: scoring uses a 10x threshold (vs 3x in steady state). Full sensitivity in ~${min} more minute(s).`,
      )
    }
  }

  if (changesMeta) {
    if (changesMeta.baselineStatus === 'empty') {
      notes.push(
        `Baseline window for change detection is empty (${changesMeta.previousWindowEvents ?? 0} events in the prior window). Empty 'new', 'spike', and 'resolved' arrays mean "we have no baseline to compare against", not "nothing has changed".`,
      )
    } else if (changesMeta.baselineStatus === 'sparse') {
      notes.push(
        `Baseline window is sparse (${changesMeta.previousWindowEvents ?? 0} events). Spike ratios may be noisier than usual.`,
      )
    }
  }

  return notes
}

/**
 * Format the notes as a markdown block to append to a tool's text output.
 * Returns an empty string if there are no notes (system is steady).
 */
export function formatSystemStateBlock(notes: string[]): string {
  if (notes.length === 0) return ''
  let text = `\n---\n### System state\n\n`
  for (const note of notes) {
    text += `- ${note}\n`
  }
  return text
}
