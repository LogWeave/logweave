import { Activity, AlertTriangle, Inbox, Layers, Sparkles, Unplug, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { useOverview, useTemplates } from '../../api/queries'
import { QueryError } from '../../components/ui/query-error'
import { cn } from '../../lib/cn'
import { TOOLTIPS } from '../../lib/tooltips'
import { useDashboardStore } from '../../stores/dashboard-store'
import { KpiCard } from './kpi-card'

/** Compute percentage change: ((current - previous) / previous) * 100. Returns undefined when no comparison data. */
function trendPercent(current: number, previous: number | undefined): number | undefined {
  if (previous === undefined) return undefined
  if (previous === 0) return current > 0 ? 100 : 0
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
    <div className={cn('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3', className)}>
      <KpiCard
        label="Events (24h)"
        value={overview?.totalEvents ?? 0}
        icon={Activity}
        trend={trendPercent(overview?.totalEvents ?? 0, prev?.totalEvents)}
        trendLabel={trendLabel}
        trendPolarity="positive"
        loading={isLoading}
      />
      <KpiCard
        label="Patterns"
        value={overview?.totalTemplates ?? 0}
        icon={Layers}
        tooltip={TOOLTIPS.totalTemplates}
        trend={trendPercent(overview?.totalTemplates ?? 0, prev?.totalTemplates)}
        trendLabel={trendLabel}
        trendPolarity="neutral"
        loading={isLoading}
      />
      <KpiCard
        label="New Today"
        value={overview?.newTemplatesToday ?? 0}
        icon={Sparkles}
        tooltip={TOOLTIPS.newToday}
        trend={trendPercent(overview?.newTemplatesToday ?? 0, prev?.newTemplatesToday)}
        trendLabel={trendLabel}
        trendPolarity="neutral"
        variant={
          overview?.newTemplatesToday && overview.newTemplatesToday > 0 ? 'warning' : 'default'
        }
        loading={isLoading}
      />
      <KpiCard
        label="Unclustered"
        value={overview?.unclusteredCount ?? 0}
        icon={Unplug}
        tooltip={TOOLTIPS.unclustered}
        trend={trendPercent(overview?.unclusteredCount ?? 0, prev?.unclusteredCount)}
        trendLabel={trendLabel}
        variant={
          overview?.unclusteredCount && overview.unclusteredCount > 0 ? 'warning' : 'default'
        }
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
        label="Spikes Active"
        value={spikeCount}
        icon={Zap}
        tooltip="Patterns with anomaly score above 1.0 (spiking above baseline)"
        variant={spikeCount > 3 ? 'danger' : spikeCount > 0 ? 'warning' : 'default'}
        loading={isLoading}
      />
    </div>
  )
}
