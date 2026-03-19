import { Activity, AlertTriangle, Layers, Sparkles, Unplug, Zap } from 'lucide-react'
import { useOverview, useTemplates } from '../../api/queries'
import { cn } from '../../lib/cn'
import { TOOLTIPS } from '../../lib/tooltips'
import { KpiCard } from './kpi-card'

/** Compute percentage change: ((current - previous) / previous) * 100. Returns undefined when no comparison data. */
function trendPercent(current: number, previous: number | undefined): number | undefined {
  if (previous === undefined) return undefined
  if (previous === 0) return current > 0 ? 100 : 0
  return ((current - previous) / previous) * 100
}

export function KpiStrip({ className }: { className?: string }) {
  const { data: response, isLoading } = useOverview()
  const { data: templatesResponse } = useTemplates()
  const overview = response?.data
  const prev = overview?.previous

  const spikeCount =
    templatesResponse?.data?.filter((t) => t.maxAnomalyScore > 1.0).length ?? 0

  return (
    <div className={cn('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3', className)}>
      <KpiCard
        label="Events (24h)"
        value={overview?.totalEvents ?? 0}
        icon={Activity}
        trend={trendPercent(overview?.totalEvents ?? 0, prev?.totalEvents)}
        trendPolarity="positive"
        loading={isLoading}
      />
      <KpiCard
        label="Patterns"
        value={overview?.totalTemplates ?? 0}
        icon={Layers}
        tooltip={TOOLTIPS.totalTemplates}
        trend={trendPercent(overview?.totalTemplates ?? 0, prev?.totalTemplates)}
        trendPolarity="neutral"
        loading={isLoading}
      />
      <KpiCard
        label="New Today"
        value={overview?.newTemplatesToday ?? 0}
        icon={Sparkles}
        tooltip={TOOLTIPS.newToday}
        trend={trendPercent(overview?.newTemplatesToday ?? 0, prev?.newTemplatesToday)}
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
        variant={
          overview?.unclusteredCount && overview.unclusteredCount > 0 ? 'warning' : 'default'
        }
        loading={isLoading}
      />
      <KpiCard
        label="Error Rate"
        value={overview ? `${overview.errorRate.toFixed(1)}%` : '0%'}
        icon={AlertTriangle}
        tooltip={TOOLTIPS.errorRate}
        trend={trendPercent(overview?.errorRate ?? 0, prev?.errorRate)}
        trendSuffix="pp"
        variant={overview?.errorRate && overview.errorRate > 5 ? 'danger' : 'default'}
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
