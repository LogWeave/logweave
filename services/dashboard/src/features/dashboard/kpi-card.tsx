import type { LucideIcon } from 'lucide-react'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'

interface KpiCardProps {
  label: string
  value: string | number
  icon: LucideIcon
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
  trend,
  trendSuffix = '%',
  variant = 'default',
  loading,
  className,
}: KpiCardProps) {
  if (loading) {
    return (
      <Card className={cn('min-h-[100px]', className)}>
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-24" />
          </div>
          <Skeleton className="h-9 w-9 rounded-[var(--radius-md)]" />
        </div>
      </Card>
    )
  }

  return (
    <Card className={cn('min-h-[100px]', className)}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-1">
            {label}
          </p>
          <p
            className={cn(
              'text-2xl font-bold font-mono tabular-nums',
              variant === 'danger' && 'text-danger',
              variant === 'warning' && 'text-warning',
              variant === 'default' && 'text-text-primary',
            )}
          >
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
          {trend !== undefined && (
            <div className="mt-1">
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-xs font-medium',
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
            'h-9 w-9 rounded-[var(--radius-md)] flex items-center justify-center',
            variant === 'danger' && 'bg-red-500/10 text-danger',
            variant === 'warning' && 'bg-amber-500/10 text-warning',
            variant === 'default' && 'bg-brand-500/10 text-brand-400',
          )}
        >
          <Icon size={18} />
        </div>
      </div>
    </Card>
  )
}
