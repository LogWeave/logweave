import { Server } from 'lucide-react'
import { useShallow } from 'zustand/shallow'
import { useServices } from '../../api/queries'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import { useDashboardStore } from '../../stores/dashboard-store'

export function ServiceHealthCards({ className }: { className?: string }) {
  const { data: response, isLoading } = useServices()
  const services = response?.data ?? []
  const { serviceFilter, setServiceFilter } = useDashboardStore(
    useShallow((s) => ({ serviceFilter: s.serviceFilter, setServiceFilter: s.setServiceFilter })),
  )

  if (isLoading) {
    return (
      <div className={cn('space-y-3', className)}>
        <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          Services
        </h3>
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    )
  }

  if (services.length === 0) {
    return (
      <div className={cn('space-y-3', className)}>
        <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          Services
        </h3>
        <p className="text-xs text-text-muted">No services reporting.</p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wider">Services</h3>
      {services.map((svc) => {
        const isActive = serviceFilter === svc.service
        return (
          <Card
            key={svc.service}
            variant="interactive"
            onClick={() => setServiceFilter(isActive ? null : svc.service)}
            className={cn(isActive && 'border-brand-500/50 bg-brand-500/5')}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'h-8 w-8 rounded-[var(--radius-md)] flex items-center justify-center shrink-0',
                  svc.errorRate > 5
                    ? 'bg-red-500/10 text-danger'
                    : 'bg-brand-500/10 text-brand-400',
                )}
              >
                <Server size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-primary truncate">{svc.service}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-text-muted font-mono tabular-nums">
                    {svc.logCount.toLocaleString()} events
                  </span>
                  {svc.errorRate > 0 && (
                    <span className="text-xs text-danger font-mono tabular-nums">
                      {svc.errorRate.toFixed(1)}% err
                    </span>
                  )}
                </div>
              </div>
              {svc.newTemplateCount > 0 && (
                <Badge variant="new" className="shrink-0">
                  {svc.newTemplateCount} new
                </Badge>
              )}
            </div>
          </Card>
        )
      })}
    </div>
  )
}
