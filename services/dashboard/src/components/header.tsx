import { useQueryClient } from '@tanstack/react-query'
import { Moon, RefreshCw, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { useLevels, useOverview } from '../api/queries'
import { cn } from '../lib/cn'
import { type TimeRange, useDashboardStore } from '../stores/dashboard-store'
import { Button } from './ui/button'
import { ToggleGroup } from './ui/toggle'

const timeRangeOptions = [
  { value: '1h', label: '1H' },
  { value: '6h', label: '6H' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
]

const levelPillColors: Record<string, string> = {
  ERROR: 'bg-red-500/15 text-red-400 border-red-500/30',
  WARN: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  INFO: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  DEBUG: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  TRACE: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
}

export function Header() {
  const {
    timeRange,
    setTimeRange,
    colorMode,
    toggleColorMode,
    serviceFilter,
    setServiceFilter,
    levelFilters,
    toggleLevelFilter,
    setLevelFilters,
    clearLevelFilters,
  } = useDashboardStore(
    useShallow((s) => ({
      timeRange: s.timeRange,
      setTimeRange: s.setTimeRange,
      colorMode: s.colorMode,
      toggleColorMode: s.toggleColorMode,
      serviceFilter: s.serviceFilter,
      setServiceFilter: s.setServiceFilter,
      levelFilters: s.levelFilters,
      toggleLevelFilter: s.toggleLevelFilter,
      setLevelFilters: s.setLevelFilters,
      clearLevelFilters: s.clearLevelFilters,
    })),
  )
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const { data: levelsResponse } = useLevels()
  const levelsData = levelsResponse?.data
  const { dataUpdatedAt, isError: overviewError } = useOverview()
  const [secondsAgo, setSecondsAgo] = useState(0)

  useEffect(() => {
    if (!dataUpdatedAt) return
    const update = () => setSecondsAgo(Math.round((Date.now() - dataUpdatedAt) / 1000))
    update()
    const id = setInterval(update, 5_000)
    return () => clearInterval(id)
  }, [dataUpdatedAt])

  const handleRefresh = () => {
    setRefreshing(true)
    queryClient.invalidateQueries().then(() => setRefreshing(false))
  }

  return (
    <header className="h-14 flex items-center justify-between px-4 md:px-6 border-b border-border-subtle bg-surface-raised">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold text-text-primary hidden sm:block">Dashboard</h1>
        {serviceFilter && (
          <button
            type="button"
            onClick={() => setServiceFilter(null)}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full bg-brand-500/10 text-brand-400 border border-brand-500/20 hover:bg-brand-500/20 transition-colors"
          >
            {serviceFilter}
            <span className="text-brand-400/60">&times;</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (levelFilters.length === 1 && levelFilters[0] === 'ERROR') {
              clearLevelFilters()
            } else {
              setLevelFilters(['ERROR'])
            }
          }}
          className={cn(
            'hidden sm:inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-[var(--radius-md)] border transition-colors',
            levelFilters.length === 1 && levelFilters[0] === 'ERROR'
              ? 'bg-red-500/15 text-red-400 border-red-500/30'
              : 'text-text-muted border-border-subtle hover:text-text-secondary hover:border-border',
          )}
        >
          Errors Only
        </button>
        {levelsData && levelsData.length > 0 && (
          <div className="hidden md:flex items-center gap-1">
            {levelsData.map((l) => (
              <button
                key={l.level}
                type="button"
                onClick={() => toggleLevelFilter(l.level)}
                className={cn(
                  'px-2 py-0.5 text-[11px] font-medium rounded-full border transition-colors',
                  levelFilters.includes(l.level)
                    ? (levelPillColors[l.level] ??
                        'bg-brand-500/10 text-brand-400 border-brand-500/20')
                    : 'text-text-muted border-border-subtle hover:text-text-secondary hover:border-border',
                )}
              >
                {l.level || '(none)'} ({l.count.toLocaleString()})
              </button>
            ))}
          </div>
        )}
        {(levelFilters.length > 0 || serviceFilter) && (
          <button
            type="button"
            onClick={() => {
              clearLevelFilters()
              setServiceFilter(null)
            }}
            className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <ToggleGroup
          options={timeRangeOptions}
          value={timeRange}
          onChange={(v) => setTimeRange(v as TimeRange)}
        />
        {dataUpdatedAt > 0 && (
          <span
            className={cn(
              'hidden sm:inline text-[11px] tabular-nums',
              overviewError
                ? 'text-danger'
                : secondsAgo > 120
                  ? 'text-warning'
                  : 'text-text-muted',
            )}
          >
            {overviewError
              ? 'API error'
              : secondsAgo < 10
                ? 'Updated just now'
                : `Updated ${secondsAgo}s ago`}
          </span>
        )}
        <Button variant="ghost" size="sm" title="Refresh" aria-label="Refresh data" onClick={handleRefresh}>
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </Button>
        <Button variant="ghost" size="sm" onClick={toggleColorMode} title="Toggle theme" aria-label="Toggle theme">
          {colorMode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </Button>
      </div>
    </header>
  )
}
