import { useCallback, useEffect, useRef, useState } from 'react'
import { useServices } from '../../api/queries'
import { AnomalyWarmupBanner } from '../../components/anomaly-warmup-banner'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { formatTimeOfDay } from '../../lib/format-time'
import { useDashboardStore } from '../../stores/dashboard-store'
import { type TailEvent, type TailFilters, useTail } from './use-tail'

const LEVEL_COLORS: Record<string, string> = {
  ERROR: 'text-red-400',
  WARN: 'text-yellow-400',
  INFO: 'text-green-400',
  DEBUG: 'text-text-muted',
  FATAL: 'text-purple-400',
}

function EventRow({ event, timezoneMode }: { event: TailEvent; timezoneMode: 'local' | 'utc' }) {
  const levelColor = LEVEL_COLORS[event.level] ?? 'text-text-secondary'
  const isAnomaly = event.anomalyScore > 0.5
  const { primary: ts, alternate: tsAlt } = formatTimeOfDay(event.timestamp, timezoneMode)

  return (
    <div
      className={`flex items-start gap-2 py-1 px-3 hover:bg-surface-elevated text-xs font-mono ${event.level === 'ERROR' ? 'bg-red-500/5' : event.level === 'WARN' ? 'bg-amber-500/5' : ''}`}
    >
      <span className="text-text-muted shrink-0 w-16" title={tsAlt}>
        {ts}
      </span>
      <span className={`shrink-0 w-12 font-semibold ${levelColor}`}>{event.level}</span>
      <span className="text-brand-400 shrink-0 w-28 truncate" title={event.service}>
        {event.service}
      </span>
      {event.statusCode > 0 && (
        <span className="text-text-muted shrink-0 w-8">[{event.statusCode}]</span>
      )}
      <span className="text-text-primary flex-1 truncate" title={event.templateText}>
        {event.preProcessedMessage ?? event.templateText}
      </span>
      {event.durationMs > 0 && (
        <span className="text-text-muted shrink-0 w-16 text-right">{event.durationMs}ms</span>
      )}
      {isAnomaly && (
        <Badge
          variant="error"
          className="shrink-0 text-[10px]"
          title={`Anomaly score ${event.anomalyScore.toFixed(2)} — events with score > 1.0 deviate significantly from this template's baseline volume`}
        >
          ⚠ {event.anomalyScore.toFixed(2)}
        </Badge>
      )}
    </div>
  )
}

export function TailPage() {
  const [filters, setFilters] = useState<TailFilters>({})
  const [paused, setPaused] = useState(false)
  const tailTimezone = useDashboardStore((s) => s.tailTimezone)
  const toggleTailTimezone = useDashboardStore((s) => s.toggleTailTimezone)
  const { data: servicesResponse } = useServices()
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  const { events, status, error, eventRate, connect, disconnect, isConnected, clear } =
    useTail(filters)

  // Auto-scroll to bottom when new events arrive. `events.length` is in the
  // dep list as the *trigger* (new event → re-run); the effect body itself
  // reads scrollHeight directly. Removing it would break auto-scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events.length is the trigger signal
  useEffect(() => {
    if (!paused && autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events.length, paused])

  // Detect if user scrolled up (disable auto-scroll)
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50
  }, [])

  const statusLabel = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    connected: 'Connected',
    error: 'Error',
  }[status]

  const statusColor = {
    disconnected: 'bg-text-muted',
    connecting: 'bg-yellow-400',
    connected: 'bg-green-400',
    error: 'bg-red-400',
  }[status]

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 p-3 border-b border-border-subtle bg-surface-raised">
        {status === 'disconnected' && (
          <Button size="sm" onClick={connect}>
            Start Tail
          </Button>
        )}
        {status === 'connecting' && (
          <Button size="sm" disabled>
            <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse mr-1.5" />
            Connecting...
          </Button>
        )}
        {status === 'connected' && (
          <Button size="sm" variant="secondary" onClick={disconnect}>
            <div className="h-2 w-2 rounded-full bg-success animate-pulse mr-1.5" />
            Stop
          </Button>
        )}
        {status === 'error' && (
          <Button size="sm" variant="secondary" onClick={connect}>
            Retry
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPaused(!paused)}
          disabled={!isConnected}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>

        <Button size="sm" variant="ghost" onClick={clear} disabled={events.length === 0}>
          Clear
        </Button>

        <div className="h-5 w-px bg-border-subtle" />

        {/* Filters */}
        <Select
          value={filters.service ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, service: e.target.value || undefined }))}
          className="w-36 text-xs"
          options={[
            { value: '', label: 'All services' },
            ...(servicesResponse?.data ?? []).map((s) => ({ value: s.service, label: s.service })),
          ]}
        />

        <Select
          value={filters.level ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, level: e.target.value || undefined }))}
          className="w-24 text-xs"
          options={[
            { value: '', label: 'All levels' },
            { value: 'ERROR', label: 'ERROR' },
            { value: 'WARN', label: 'WARN' },
            { value: 'INFO', label: 'INFO' },
            { value: 'DEBUG', label: 'DEBUG' },
          ]}
        />

        <div className="flex-1" />

        {/* Status indicators */}
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <button
            type="button"
            onClick={toggleTailTimezone}
            title={`Currently showing ${tailTimezone === 'local' ? 'local time' : 'UTC'}. Click to switch.`}
            className="px-1.5 py-0.5 rounded border border-border-subtle hover:bg-surface-elevated text-[10px] font-mono uppercase"
          >
            {tailTimezone === 'local' ? 'LOCAL' : 'UTC'}
          </button>
          <span>{events.length} events</span>
          {isConnected && <span>{eventRate}/sec</span>}
          <div className="flex items-center gap-1.5">
            <div className={`h-2 w-2 rounded-full ${statusColor}`} />
            <span>{statusLabel}</span>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1.5 bg-red-500/10 text-red-400 text-xs border-b border-red-500/20">
          {error}
        </div>
      )}

      {/* Anomaly warmup banner — hidden once scoring reaches steady state */}
      <AnomalyWarmupBanner className="mx-3 my-2" />

      {/* Event stream */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-surface-base"
      >
        {events.length === 0 && !isConnected && (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            Click "Start Tail" to begin streaming live events
          </div>
        )}
        {events.length === 0 && isConnected && (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            Waiting for events...
          </div>
        )}
        {!paused &&
          events.map((e) => <EventRow key={e.seq} event={e} timezoneMode={tailTimezone} />)}
        {paused && (
          <div className="p-3 text-center text-text-muted text-xs">
            Paused — {events.length} events buffered
          </div>
        )}
      </div>
    </div>
  )
}
