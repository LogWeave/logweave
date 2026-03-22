import { memo } from 'react'
import { useChanges, useOverview } from '../../api/queries'
import type { ChangeEvent } from '../../api/types'
import { QueryError } from '../../components/ui/query-error'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { Tooltip } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { TOOLTIPS } from '../../lib/tooltips'
import { useDashboardStore } from '../../stores/dashboard-store'

const BADGE_TOOLTIPS = {
  spike: TOOLTIPS.spikeEvent,
  new: TOOLTIPS.newEvent,
  resolved: TOOLTIPS.resolvedEvent,
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
              {new Date(event.firstSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {event.type === 'spike' && (
            <>
              <span
                className={cn(
                  'text-[11px] font-mono tabular-nums font-semibold',
                  event.ratio >= 50 ? 'text-danger' : event.ratio >= 10 ? 'text-warning' : 'text-text-secondary',
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
  const { data: response, isLoading, isError, refetch } = useChanges()
  const { data: overviewResponse } = useOverview()
  const changesData = response?.data
  const spikes = changesData?.spike ?? []
  const newEvents = changesData?.new ?? []
  const resolved = changesData?.resolved ?? []
  const totalCount = spikes.length + newEvents.length + resolved.length
  const hasAnyData = (overviewResponse?.data?.totalEvents ?? 0) > 0
  const setSelectedTemplateId = useDashboardStore((s) => s.setSelectedTemplateId)

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
          <p className="text-xs text-text-muted py-4 text-center">
            {hasAnyData
              ? 'All quiet — no spikes, new patterns, or resolutions in this window.'
              : 'Waiting for log data to start detecting changes.'}
          </p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-2">
            {spikes.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Spikes ({spikes.length})
                </p>
                {spikes.map((event) => (
                  <ChangeEventRow key={`${event.templateId}-${event.service}`} event={event} onSelect={setSelectedTemplateId} />
                ))}
              </div>
            )}
            {newEvents.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  New Patterns ({newEvents.length})
                </p>
                {newEvents.map((event) => (
                  <ChangeEventRow key={`${event.templateId}-${event.service}`} event={event} onSelect={setSelectedTemplateId} />
                ))}
              </div>
            )}
            {resolved.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Resolved ({resolved.length})
                </p>
                {resolved.map((event) => (
                  <ChangeEventRow key={`${event.templateId}-${event.service}`} event={event} onSelect={setSelectedTemplateId} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
