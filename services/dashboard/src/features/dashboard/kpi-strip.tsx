import { Activity, AlertTriangle, Layers, Sparkles, Unplug } from 'lucide-react'
import { useOverview } from '../../api/queries'
import { cn } from '../../lib/cn'
import { KpiCard } from './kpi-card'

export function KpiStrip({ className }: { className?: string }) {
  const { data: response, isLoading } = useOverview()
  const overview = response?.data

  return (
    <div className={cn('grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4', className)}>
      <KpiCard
        label="Events (24h)"
        value={overview?.totalEvents ?? 0}
        icon={Activity}
        loading={isLoading}
      />
      <KpiCard
        label="Templates"
        value={overview?.totalTemplates ?? 0}
        icon={Layers}
        loading={isLoading}
      />
      <KpiCard
        label="New Today"
        value={overview?.newTemplatesToday ?? 0}
        icon={Sparkles}
        variant={
          overview?.newTemplatesToday && overview.newTemplatesToday > 0 ? 'warning' : 'default'
        }
        loading={isLoading}
      />
      <KpiCard
        label="Unclustered"
        value={overview?.unclusteredCount ?? 0}
        icon={Unplug}
        variant={
          overview?.unclusteredCount && overview.unclusteredCount > 0 ? 'warning' : 'default'
        }
        loading={isLoading}
      />
      <KpiCard
        label="Error Rate"
        value={overview ? `${overview.errorRate.toFixed(1)}%` : '0%'}
        icon={AlertTriangle}
        variant={overview?.errorRate && overview.errorRate > 5 ? 'danger' : 'default'}
        loading={isLoading}
      />
    </div>
  )
}
