import { useChanges } from '../../api/queries'
import type { ChangeEvent } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { Tooltip } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { TOOLTIPS } from '../../lib/tooltips'

const BADGE_TOOLTIPS = {
  spike: TOOLTIPS.spikeEvent,
  new: TOOLTIPS.newEvent,
  resolved: TOOLTIPS.resolvedEvent,
}

function ChangeEventRow({ event }: { event: ChangeEvent }) {
  const badgeVariant = event.type === 'new' ? 'new' : event.type === 'spike' ? 'spike' : 'resolved'
  const label = event.type.toUpperCase()

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border-subtle/50 last:border-0">
      <Tooltip content={BADGE_TOOLTIPS[event.type]} className="mt-0.5 shrink-0">
        <Badge variant={badgeVariant}>{label}</Badge>
      </Tooltip>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-mono text-text-primary truncate">{event.templateText}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-text-muted">{event.service}</span>
          {event.type === 'spike' && (
            <span className="text-[11px] text-warning font-mono tabular-nums">
              {event.ratio.toFixed(1)}x
            </span>
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
    </div>
  )
}

export function ChangesPanel({ className }: { className?: string }) {
  const { data: response, isLoading } = useChanges()
  const events = response?.data ?? []

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
        {events.length === 0 ? (
          <p className="text-xs text-text-muted py-4 text-center">
            No changes detected in this time window.
          </p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto">
            {events.map((event) => (
              <ChangeEventRow key={`${event.type}-${event.templateId}`} event={event} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
