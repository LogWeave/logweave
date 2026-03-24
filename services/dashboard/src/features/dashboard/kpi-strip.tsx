import { Activity, AlertTriangle, Inbox, Layers, Server, Sparkles, Unplug, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { useOverview, useTemplates } from '../../api/queries'
import { QueryError } from '../../components/ui/query-error'
import { cn } from '../../lib/cn'
import { useDashboardStore } from '../../stores/dashboard-store'
import { KpiCard } from './kpi-card'
import { TOOLTIPS } from '../../lib/tooltips'

function trendPercent(current: number, previous?: number): number | undefined {
  if (previous === undefined || previous === 0) return undefined
  return ((current - previous) / previous) * 100
}

export function KpiStrip({ className }: { className?: string }) {
  const { data: response, isLoading, isError, refetch } = useOverview()
  const { data: templatesResponse } = useTemplates()
  const overview = response?.data
  const prev = overview?.previous

  const timeRange = useDashboardStore((s) => s.timeRange)
  const trendLabel = {
    '1h': 'vs prev 1h',
    '6h': 'vs prev 6h',
    '24h': 'vs prev 24h',
    '7d': 'vs prev 7d',
  }[timeRange]

  const spikeCount = useMemo(
    () => templatesResponse?.data?.filter((t) => t.maxAnomalyScore > 1.0).length ?? 0,
    [templatesResponse?.data],
  )

  if (isError) {
    return (
      <div className={cn('col-span-full', className)}>
        <QueryError message="Failed to load dashboard metrics" onRetry={() => refetch()} />
      </div>
    )
  }

  const hasNoData =
    !isLoading && overview && overview.totalEvents === 0 && overview.totalTemplates === 0

  if (hasNoData) {
    return (
      <div
        className={cn(
          'rounded-[var(--radius-lg)] border border-border-subtle bg-surface-raised p-6 text-center',
          className,
        )}
      >
        <Inbox size={32} className="mx-auto mb-3 text-text-muted" />
        <p className="text-sm font-medium text-text-primary mb-1">Waiting for data...</p>
        <p className="text-xs text-text-muted">
          Install the <code className="text-brand-400">@logweave/transport</code> SDK and send your
          first logs to see metrics here.
        </p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* Primary row — hero metrics that matter for triage */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Spikes Active"
          value={spikeCount}
          icon={Zap}
          tooltip={TOOLTIPS.spikesActive}
          trendPolarity="negative"
          variant={spikeCount > 0 ? 'danger' : 'default'}
          loading={isLoading}
        />
        <KpiCard
          label="Error Rate"
          value={overview ? `${(overview.errorRate * 100).toFixed(1)}%` : '0%'}
          icon={AlertTriangle}
          tooltip={TOOLTIPS.errorRate}
          trend={trendPercent(overview?.errorRate ?? 0, prev?.errorRate)}
          trendSuffix="pp"
          trendLabel={trendLabel}
          variant={overview?.errorRate && overview.errorRate > 0.05 ? 'danger' : 'default'}
          loading={isLoading}
        />
        <KpiCard
          label="Events"
          value={overview?.totalEvents ?? 0}
          icon={Activity}
          trend={trendPercent(overview?.totalEvents ?? 0, prev?.totalEvents)}
          trendLabel={trendLabel}
          trendPolarity="positive"
          loading={isLoading}
        />
      </div>

      {/* Secondary row — compact pills for lower-priority metrics */}
      <div className="flex flex-wrap items-center gap-2">
        <SecondaryPill
          icon={Layers}
          label="Patterns"
          value={overview?.totalTemplates ?? 0}
          loading={isLoading}
        />
        <SecondaryPill
          icon={Sparkles}
          label="New Today"
          value={overview?.newTemplatesToday ?? 0}
          variant={overview?.newTemplatesToday && overview.newTemplatesToday > 0 ? 'warning' : undefined}
          loading={isLoading}
        />
        <SecondaryPill
          icon={Server}
          label="Services"
          value={overview?.serviceCount ?? 0}
          loading={isLoading}
        />
        <SecondaryPill
          icon={Unplug}
          label="Unclustered"
          value={overview?.unclusteredCount ?? 0}
          variant={overview?.unclusteredCount && overview.unclusteredCount > 0 ? 'warning' : undefined}
          loading={isLoading}
        />
        {overview && overview.totalTemplates > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-brand-500/5 border border-brand-500/20">
            <span className="text-[10px] text-brand-400 font-medium font-mono">
              {Math.round(overview.totalEvents / overview.totalTemplates)}:1
            </span>
            <span className="text-[10px] text-brand-400 hidden sm:inline">compression</span>
          </div>
        )}
      </div>
    </div>
  )
}

function SecondaryPill({
  icon: Icon,
  label,
  value,
  variant,
  loading,
}: {
  icon: typeof Activity
  label: string
  value: number | string
  variant?: 'warning'
  loading?: boolean
}) {
  if (loading) {
    return <div className="h-8 w-28 rounded-lg bg-surface-base animate-pulse" />
  }
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs',
        variant === 'warning'
          ? 'bg-amber-500/5 border-amber-500/20 text-warning'
          : 'bg-surface-base border-border-subtle text-text-muted',
      )}
      title={label}
    >
      <Icon size={12} />
      <span className="uppercase text-[10px] hidden sm:inline">{label}</span>
      <span className={cn('font-bold font-mono tabular-nums', variant === 'warning' ? 'text-warning' : 'text-text-primary')}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </div>
  )
}
