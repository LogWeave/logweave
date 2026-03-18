import type { LucideIcon } from 'lucide-react'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { InfoTooltip } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'

interface KpiCardProps {
  label: string
  value: string | number
  icon: LucideIcon
  tooltip?: string
  trend?: number
  trendSuffix?: string
  variant?: 'default' | 'warning' | 'danger'
  loading?: boolean
  className?: string
}

export function KpiCard({
  label,
  value,
  icon: Icon,
  tooltip,
  trend,
  trendSuffix = '%',
  variant = 'default',
  loading,
  className,
}: KpiCardProps) {
  if (loading) {
    return (
      <Card size="compact" className={className}>
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-16" />
          </div>
          <Skeleton className="h-7 w-7 rounded-[var(--radius-md)]" />
        </div>
      </Card>
    )
  }

  return (
    <Card size="compact" className={className}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1 mb-1">
            <p className="text-[11px] font-medium text-text-secondary uppercase tracking-wider truncate">
              {label}
            </p>
            {tooltip && <InfoTooltip content={tooltip} />}
          </div>
          <p
            className={cn(
              'text-xl font-bold font-mono tabular-nums',
              variant === 'danger' && 'text-danger',
              variant === 'warning' && 'text-warning',
              variant === 'default' && 'text-text-primary',
            )}
          >
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
          {trend !== undefined && (
            <div className="mt-0.5">
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 text-xs font-medium',
                  trend > 0 && 'text-danger',
                  trend < 0 && 'text-success',
                  trend === 0 && 'text-text-muted',
                )}
              >
                {trend > 0 ? '\u2191' : trend < 0 ? '\u2193' : '\u2192'}
                {trend !== 0 && ` ${Math.abs(trend).toFixed(1)}${trendSuffix}`}
                {trend === 0 && ' stable'}
              </span>
            </div>
          )}
        </div>
        <div
          className={cn(
            'h-7 w-7 shrink-0 rounded-[var(--radius-md)] flex items-center justify-center',
            variant === 'danger' && 'bg-red-500/10 text-danger',
            variant === 'warning' && 'bg-amber-500/10 text-warning',
            variant === 'default' && 'bg-brand-500/10 text-brand-400',
          )}
        >
          <Icon size={15} />
        </div>
      </div>
    </Card>
  )
}
