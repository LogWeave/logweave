import { useClusteringHealth } from '../../api/queries'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'

export function CompressionFunnel({ className }: { className?: string }) {
  const { data: response, isLoading } = useClusteringHealth()
  const health = response?.data

  if (isLoading) {
    return <Skeleton className={cn('h-24', className)} />
  }

  if (!health || health.totalEvents === 0) {
    return null
  }

  const ratio =
    health.uniqueTemplates > 0 ? Math.round(health.totalEvents / health.uniqueTemplates) : 0
  const templatePct =
    health.totalEvents > 0 ? Math.max(8, (health.uniqueTemplates / health.totalEvents) * 100) : 8

  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
            Compression
          </span>
          <span className="text-xs font-mono text-brand-400 tabular-nums">{ratio}:1 ratio</span>
        </div>

        {/* Funnel visual */}
        <div className="space-y-1.5">
          {/* Top bar: total events (full width) */}
          <div className="relative">
            <div className="h-7 rounded-[var(--radius-sm)] bg-surface-elevated flex items-center px-3">
              <span className="text-xs font-mono tabular-nums text-text-primary">
                {health.totalEvents.toLocaleString()}
              </span>
              <span className="text-[10px] text-text-muted ml-1.5">events</span>
            </div>
          </div>

          {/* Taper connector */}
          <div className="flex justify-center">
            <svg
              width="24"
              height="12"
              viewBox="0 0 24 12"
              className="text-brand-500/30"
              role="img"
              aria-label="Funnel taper"
            >
              <path d="M0,0 L24,0 L18,12 L6,12 Z" fill="currentColor" />
            </svg>
          </div>

          {/* Bottom bar: unique templates (proportional width) */}
          <div className="relative" style={{ width: `${templatePct}%`, minWidth: '120px' }}>
            <div className="h-7 rounded-[var(--radius-sm)] bg-brand-500/20 border border-brand-500/30 flex items-center px-3">
              <span className="text-xs font-mono tabular-nums text-brand-400 font-medium">
                {health.uniqueTemplates.toLocaleString()}
              </span>
              <span className="text-[10px] text-brand-400/60 ml-1.5">patterns</span>
            </div>
          </div>
        </div>

        {/* Unclustered indicator */}
        {health.unclusteredEvents > 0 && (
          <div className="mt-2 flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-warning" />
            <span className="text-[10px] text-text-muted">
              {health.unclusteredEvents.toLocaleString()} unclustered
            </span>
          </div>
        )}
      </div>
    </Card>
  )
}
