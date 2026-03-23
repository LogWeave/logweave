import { Bell, Server } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import { useCreateRule, useRules, useServices } from '../../api/queries'
import type { ThresholdConfig } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { QueryError } from '../../components/ui/query-error'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import { useDashboardStore } from '../../stores/dashboard-store'

export function ServiceHealthCards({ className }: { className?: string }) {
  const createRuleMutation = useCreateRule()
  const { data: rulesResponse } = useRules()
  const rulesServices = useMemo(() => {
    const rules = rulesResponse?.data ?? []
    return new Set(
      rules
        .filter((r) => r.ruleType === 'threshold')
        .map((r) => (r.config as ThresholdConfig).service),
    )
  }, [rulesResponse?.data])
  const { data: response, isLoading, isError, refetch } = useServices()
  const services = useMemo(
    () =>
      [...(response?.data ?? [])].sort((a, b) => {
        const aErrors = Math.round((a.logCount * a.errorRate) / 100)
        const bErrors = Math.round((b.logCount * b.errorRate) / 100)
        return bErrors - aErrors || b.errorRate - a.errorRate
      }),
    [response?.data],
  )
  const { serviceFilter, setServiceFilter } = useDashboardStore(
    useShallow((s) => ({ serviceFilter: s.serviceFilter, setServiceFilter: s.setServiceFilter })),
  )

  if (isLoading) {
    return (
      <div className={cn('space-y-3', className)}>
        <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">
          Services
        </h3>
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <div className={cn('space-y-3', className)}>
        <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">
          Services
        </h3>
        <QueryError onRetry={() => refetch()} />
      </div>
    )
  }

  if (services.length === 0) {
    return (
      <div className={cn('space-y-3', className)}>
        <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">
          Services
        </h3>
        <p className="text-xs text-text-muted">
          No services reporting yet. Install the @logweave/transport SDK to start sending logs.
        </p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">Services</h3>
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
              <button
                type="button"
                className={cn(
                  'shrink-0 h-7 w-7 rounded-md flex items-center justify-center transition-colors',
                  rulesServices.has(svc.service)
                    ? 'text-success cursor-default'
                    : 'text-text-muted hover:text-brand-400 hover:bg-brand-500/10',
                )}
                title={
                  rulesServices.has(svc.service)
                    ? `Alert rule exists for ${svc.service}`
                    : `Alert on ${svc.service}`
                }
                onClick={(e) => {
                  e.stopPropagation()
                  if (rulesServices.has(svc.service)) return
                  createRuleMutation.mutate(
                    {
                      name: `High error rate — ${svc.service}`,
                      ruleType: 'threshold',
                      config: {
                        metric: 'error_count',
                        service: svc.service,
                        operator: '>',
                        value: 10,
                        windowMinutes: 5,
                      },
                    },
                    {
                      onSuccess: () => toast.success(`Alert rule created for ${svc.service}`),
                      onError: () => toast.error('Failed to create alert rule'),
                    },
                  )
                }}
                disabled={createRuleMutation.isPending}
              >
                <Bell size={14} />
              </button>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
