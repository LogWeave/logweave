import { useAnomalyState } from '../api/queries'
import { cn } from '../lib/cn'

/**
 * Small banner that explains why anomaly scores are 0 during the cold-start +
 * warmup window after a fresh start. Renders only while the scorer hasn't
 * reached steady state. Polls once a minute via useAnomalyState.
 *
 * Surfaces on:
 *   - Live Tail page (where the absence of `⚠ X.XX` badges is most visible)
 *   - Dashboard (where maxAnomalyScore=0 universal makes the patterns table
 *     look like nothing is anomalous)
 *
 * See ADR-014 for the underlying 7-day baseline rationale.
 */
export function AnomalyWarmupBanner({ className }: { className?: string }) {
  const { data } = useAnomalyState()
  const state = data?.data
  if (!state) return null

  // Nothing to say once we're past warmup, or if the tenant has never ingested.
  if (state.phase === 'steady' || state.phase === 'unknown') return null

  const remainingMinutes = Math.max(1, Math.ceil(state.warmupRemainingMs / 60_000))
  const phaseLabel = state.phase === 'cold-start' ? 'cold start' : 'warming up'
  const headline = `Anomaly detection is ${phaseLabel}`
  const body =
    state.phase === 'cold-start'
      ? `For the first 10 minutes after each tenant starts ingesting, anomaly scores are 0 by design. Scoring kicks in soon (~${remainingMinutes} min until full warmup).`
      : `Scores will be 0 or muted until the rolling 7-day baseline has enough data for confident detection. Steady-state scoring in ~${remainingMinutes} min.`

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs',
        className,
      )}
    >
      <span className="text-amber-400 text-sm leading-none mt-0.5">⏳</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-amber-100">{headline}</p>
        <p className="text-amber-200/70 mt-0.5 leading-relaxed">{body}</p>
      </div>
    </div>
  )
}
