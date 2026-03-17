import { Moon, RefreshCw, Sun } from 'lucide-react'
import { type TimeRange, useDashboardStore } from '../stores/dashboard-store'
import { Button } from './ui/button'
import { ToggleGroup } from './ui/toggle'

const timeRangeOptions = [
  { value: '1h', label: '1H' },
  { value: '6h', label: '6H' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
]

export function Header() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const setTimeRange = useDashboardStore((s) => s.setTimeRange)
  const colorMode = useDashboardStore((s) => s.colorMode)
  const toggleColorMode = useDashboardStore((s) => s.toggleColorMode)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const setServiceFilter = useDashboardStore((s) => s.setServiceFilter)

  return (
    <header className="h-14 flex items-center justify-between px-4 md:px-6 border-b border-border-subtle bg-surface-raised">
      {/* Left: Title + service filter */}
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
      </div>

      {/* Right: Controls */}
      <div className="flex items-center gap-2">
        <ToggleGroup
          options={timeRangeOptions}
          value={timeRange}
          onChange={(v) => setTimeRange(v as TimeRange)}
        />
        <Button variant="ghost" size="sm" title="Refresh">
          <RefreshCw size={14} />
        </Button>
        <Button variant="ghost" size="sm" onClick={toggleColorMode} title="Toggle theme">
          {colorMode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </Button>
      </div>
    </header>
  )
}
