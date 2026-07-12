import { memo } from 'react'
import { useChanges, useOverview, useSpikeBaseline } from '../../api/queries'
import type { ChangeEvent } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { QueryError } from '../../components/ui/query-error'
import { Skeleton } from '../../components/ui/skeleton'
import { Tooltip } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { TOOLTIPS } from '../../lib/tooltips'
import { useDashboardStore } from '../../stores/dashboard-store'
import { baselineEtaMessage, type SpikeSeverity, spikeRatioSeverity } from './changes-panel-data'

const BADGE_TOOLTIPS = {
  spike: TOOLTIPS.spikeEvent,
  new: TOOLTIPS.newEvent,
  resolved: TOOLTIPS.resolvedEvent,
}

const SPIKE_SEVERITY_CLASS: Record<SpikeSeverity, string> = {
  danger: 'text-danger',
  warning: 'text-warning',
  normal: 'text-text-secondary',
}

const ChangeEventRow = memo(function ChangeEventRow({
  event,
  onSelect,
}: {
  event: ChangeEvent
  onSelect: (templateId: string) => void
}) {
  const badgeVariant = event.type === 'new' ? 'new' : event.type === 'spike' ? 'spike' : 'resolved'
  const label = event.type.toUpperCase()

  return (
    <button
      type="button"
      className="flex items-start gap-3 py-2.5 border-b border-border-subtle/50 last:border-0 cursor-pointer hover:bg-surface-elevated/50 transition-colors rounded-[var(--radius-sm)] -mx-1 px-1 w-full text-left"
      onClick={() => onSelect(event.templateId)}
    >
      <Tooltip content={BADGE_TOOLTIPS[event.type]} className="mt-0.5 shrink-0">
        <Badge variant={badgeVariant}>{label}</Badge>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-mono text-text-primary truncate">{event.templateText}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-text-muted">{event.service}</span>
          {event.firstSeen && (
            <span className="text-[11px] text-text-muted">
              {new Date(event.firstSeen).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
          {event.type === 'spike' && (
            <>
              <span
                className={cn(
                  'text-[11px] font-mono tabular-nums font-semibold',
                  SPIKE_SEVERITY_CLASS[spikeRatioSeverity(event.ratio)],
                )}
              >
                {event.ratio.toFixed(1)}x
              </span>
              <span className="text-[11px] text-text-muted font-mono tabular-nums">
                {event.currentCount.toLocaleString()} events
              </span>
            </>
          )}
          {event.type === 'new' && (
            <span className="text-[11px] text-text-muted font-mono tabular-nums">
              {event.currentCount.toLocaleString()} events
            </span>
          )}
          {event.type === 'resolved' && (
            <span className="text-[11px] text-success font-mono tabular-nums">
              was {event.previousCount.toLocaleString()}
            </span>
          )}
        </div>
      </div>
    </button>
  )
})

export function ChangesPanel({ className }: { className?: string }) {
  const { data: baselineResponse } = useSpikeBaseline()
  const minBaseline = baselineResponse?.data?.minBaseline
  const { data: response, isLoading, isError, refetch } = useChanges(minBaseline)
  const { data: overviewResponse } = useOverview()
  const changesData = response?.data
  const spikes = changesData?.spike ?? []
  const newEvents = changesData?.new ?? []
  const resolved = changesData?.resolved ?? []
  const totalCount = spikes.length + newEvents.length + resolved.length
  const hasAnyData = (overviewResponse?.data?.totalEvents ?? 0) > 0
  const baselineStatus = response?.meta?.baselineStatus
  const previousWindowEvents = response?.meta?.previousWindowEvents ?? 0
  const tenantFirstSeenAt = response?.meta?.tenantFirstSeenAt
  const setSelectedTemplateId = useDashboardStore((s) => s.setSelectedTemplateId)

  // Time-until-baseline-window-ready for the empty-baseline copy. See
  // baselineEtaMessage: detection needs 2N hours of ingestion (current +
  // prior N-hour window) before the comparison is meaningful.
  const etaMessage = baselineEtaMessage(response?.meta?.hours, tenantFirstSeenAt)

  if (isLoading) {
    return (
      <Card className={cn(className)}>
        <CardHeader>
          <CardTitle>What Changed?</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {['cs-a', 'cs-b', 'cs-c', 'cs-d'].map((id) => (
              <Skeleton key={id} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle>What Changed?</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <QueryError onRetry={() => refetch()} />
        ) : totalCount === 0 ? (
          <div className="text-xs text-text-muted py-4 text-center space-y-1">
            {!hasAnyData ? (
              <p>Waiting for the first log events to arrive.</p>
            ) : baselineStatus === 'empty' ? (
              <>
                <p>Not enough history yet to detect changes.</p>
                <p className="text-text-muted/70">
                  Change detection needs ingestion to cover both the current window and the
                  equivalent prior window.
                  {etaMessage ? ` ${etaMessage}` : ''}
                </p>
              </>
            ) : (
              <p>All quiet — no spikes, new patterns, or resolutions in this window.</p>
            )}
          </div>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-2">
            {baselineStatus === 'sparse' && (
              <p className="text-[11px] text-text-muted mb-2 italic">
                Sparse baseline ({previousWindowEvents.toLocaleString()} events in prior window) —
                spike ratios may be noisier than usual.
              </p>
            )}
            {spikes.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Spikes ({spikes.length})
                </p>
                {spikes.map((event) => (
                  <ChangeEventRow
                    key={`${event.templateId}-${event.service}`}
                    event={event}
                    onSelect={setSelectedTemplateId}
                  />
                ))}
              </div>
            )}
            {newEvents.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  New Patterns ({newEvents.length})
                </p>
                {newEvents.map((event) => (
                  <ChangeEventRow
                    key={`${event.templateId}-${event.service}`}
                    event={event}
                    onSelect={setSelectedTemplateId}
                  />
                ))}
              </div>
            )}
            {resolved.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Resolved ({resolved.length})
                </p>
                {resolved.map((event) => (
                  <ChangeEventRow
                    key={`${event.templateId}-${event.service}`}
                    event={event}
                    onSelect={setSelectedTemplateId}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
