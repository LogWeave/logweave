import { useQueryClient } from '@tanstack/react-query'
import { Moon, RefreshCw, Sun } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useShallow } from 'zustand/shallow'
import { useLevels, useOverview, useServices } from '../api/queries'
import { cn } from '../lib/cn'
import { type TimeRange, useDashboardStore } from '../stores/dashboard-store'
import { Button } from './ui/button'
import type { FilterDefinition } from './ui/filter-bar'
import { FilterBar } from './ui/filter-bar'
import { ToggleGroup } from './ui/toggle'

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/alerts': 'Alerts',
  '/tail': 'Live Tail',
  '/settings': 'Settings',
}

const timeRangeOptions = [
  { value: '1h', label: '1H' },
  { value: '6h', label: '6H' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
]

export function Header() {
  const location = useLocation()
  const pageTitle = PAGE_TITLES[location.pathname] ?? 'LogWeave'
  const {
    timeRange,
    setTimeRange,
    colorMode,
    toggleColorMode,
    serviceFilter,
    setServiceFilter,
    levelFilters,
    setLevelFilters,
  } = useDashboardStore(
    useShallow((s) => ({
      timeRange: s.timeRange,
      setTimeRange: s.setTimeRange,
      colorMode: s.colorMode,
      toggleColorMode: s.toggleColorMode,
      serviceFilter: s.serviceFilter,
      setServiceFilter: s.setServiceFilter,
      levelFilters: s.levelFilters,
      setLevelFilters: s.setLevelFilters,
    })),
  )
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const { data: levelsResponse } = useLevels()
  const levelsData = levelsResponse?.data
  const { data: servicesResponse } = useServices()
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

  // Build filter definitions from live data
  const filterDefs: FilterDefinition[] = useMemo(() => {
    const defs: FilterDefinition[] = []

    // Level filter — multi-select, options from API with counts
    if (levelsData && levelsData.length > 0) {
      defs.push({
        key: 'level',
        label: 'Level',
        multiSelect: true,
        options: levelsData.map((l) => ({
          value: l.level,
          label: `${l.level || '(none)'} (${l.count.toLocaleString()})`,
        })),
      })
    }

    // Service filter — single-select, options from API
    const services = servicesResponse?.data ?? []
    if (services.length > 0) {
      defs.push({
        key: 'service',
        label: 'Service',
        options: services.map((s) => ({ value: s.service, label: s.service })),
      })
    }

    return defs
  }, [levelsData, servicesResponse?.data])

  // Build values from store state
  const filterValues: Record<string, string | undefined> = {
    level: levelFilters.length > 0 ? levelFilters.join(',') : undefined,
    service: serviceFilter ?? undefined,
  }

  const handleFilterChange = (key: string, value: string | undefined) => {
    if (key === 'level') {
      setLevelFilters(value ? value.split(',') : [])
    } else if (key === 'service') {
      setServiceFilter(value ?? null)
    }
  }

  return (
    <header className="h-14 flex items-center justify-between px-4 md:px-6 border-b border-border-subtle bg-surface-raised">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold text-text-primary hidden sm:block">{pageTitle}</h1>
        <FilterBar definitions={filterDefs} values={filterValues} onChange={handleFilterChange} />
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
              overviewError ? 'text-danger' : secondsAgo > 120 ? 'text-warning' : 'text-text-muted',
            )}
          >
            {overviewError
              ? 'API error'
              : secondsAgo < 10
                ? 'Updated just now'
                : `Updated ${secondsAgo}s ago`}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          title="Refresh"
          aria-label="Refresh data"
          onClick={handleRefresh}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleColorMode}
          title="Toggle theme"
          aria-label="Toggle theme"
        >
          {colorMode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </Button>
      </div>
    </header>
  )
}
