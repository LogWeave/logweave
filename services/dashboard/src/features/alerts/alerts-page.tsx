import { Activity, Bell, BellOff, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  useAlerts,
  useCreateRule,
  useDeleteRule,
  useRules,
  useServices,
  useUpdateRule,
} from '../../api/queries'
import type {
  AlertHistoryEntry,
  AlertRule,
  TemplateWatchConfig,
  ThresholdConfig,
} from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { FilterBar, type FilterDefinition } from '../../components/ui/filter-bar'
import { QueryError } from '../../components/ui/query-error'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'

function isThresholdConfig(rule: AlertRule): rule is AlertRule & { config: ThresholdConfig } {
  return rule.ruleType === 'threshold'
}

function RuleRow({ rule }: { rule: AlertRule }) {
  const navigate = useNavigate()
  const updateMutation = useUpdateRule()
  const deleteMutation = useDeleteRule()

  const handleToggle = () => {
    updateMutation.mutate(
      { ruleId: rule.ruleId, enabled: !rule.enabled },
      {
        onSuccess: () => toast.success(`Rule ${rule.enabled ? 'disabled' : 'enabled'}`),
        onError: () => toast.error('Failed to update rule'),
      },
    )
  }

  const handleDelete = () => {
    if (!window.confirm(`Delete rule "${rule.name}"?`)) return
    deleteMutation.mutate(rule.ruleId, {
      onSuccess: () => toast.success('Rule deleted'),
      onError: () => toast.error('Failed to delete rule'),
    })
  }

  const condition = isThresholdConfig(rule)
    ? `${rule.config.metric.replace('_', ' ')} ${rule.config.operator} ${rule.config.value} / ${rule.config.windowMinutes}min`
    : (rule.config as TemplateWatchConfig).templateText

  const service = isThresholdConfig(rule) ? rule.config.service : 'all services'

  return (
    <div
      className={cn(
        'flex items-center gap-3 py-3 px-4 border-b border-border-subtle/50 last:border-0',
        !rule.enabled && 'opacity-50',
      )}
    >
      {/* Status toggle */}
      <button
        type="button"
        className={cn(
          'shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors',
          rule.enabled
            ? 'bg-success/10 text-success hover:bg-success/20'
            : 'bg-surface-base text-text-muted hover:bg-surface-elevated',
        )}
        title={rule.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
        onClick={handleToggle}
        disabled={updateMutation.isPending}
      >
        {rule.enabled ? <Bell size={14} /> : <BellOff size={14} />}
      </button>

      {/* Rule info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-text-primary truncate">{rule.name}</span>
          <Badge variant={rule.ruleType === 'threshold' ? 'spike' : 'new'}>
            {rule.ruleType === 'threshold' ? 'threshold' : 'pattern'}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <Activity size={10} />
            {service}
          </span>
          {isThresholdConfig(rule) && rule.config.environment && (
            <Badge variant="spike">{rule.config.environment}</Badge>
          )}
          <span className="truncate">{condition}</span>
        </div>
      </div>

      {/* Channels */}
      <div className="flex items-center gap-1 shrink-0">
        {rule.channels.length > 0 ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-base text-[10px] text-text-muted">
            {rule.channels.length} webhook{rule.channels.length > 1 ? 's' : ''}
          </span>
        ) : (
          <span className="text-[10px] text-text-muted italic">Default</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          className="h-6 w-6 p-0 text-text-muted hover:text-danger"
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
        >
          <Trash2 size={12} />
        </Button>
        <button
          type="button"
          className="text-text-muted hover:text-text-primary transition-colors"
          title="Investigate on dashboard"
          onClick={() => {
            const service = isThresholdConfig(rule) ? rule.config.service : undefined
            navigate(`/?service=${service ?? ''}&range=24h`)
          }}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  )
}

function AlertHistoryRow({ alert }: { alert: AlertHistoryEntry }) {
  const ratio = alert.thresholdValue > 0 ? alert.metricValue / alert.thresholdValue : 1
  const severity = ratio > 3 ? 'text-danger' : ratio > 1.5 ? 'text-warning' : 'text-text-primary'
  const service = (alert.details?.service as string) ?? 'unknown'

  return (
    <div className="flex items-center gap-3 py-2.5 px-4 border-b border-border-subtle/50 last:border-0">
      {/* Severity dot */}
      <div
        className={cn(
          'shrink-0 w-2 h-2 rounded-full',
          ratio > 3 ? 'bg-danger' : ratio > 1.5 ? 'bg-warning' : 'bg-info',
        )}
      />

      {/* Alert info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium text-text-primary truncate">{alert.ruleName}</span>
          <Badge
            variant={
              alert.ruleType === 'threshold' || alert.ruleType === 'threshold_breach'
                ? 'spike'
                : 'new'
            }
          >
            {alert.ruleType === 'threshold' || alert.ruleType === 'threshold_breach'
              ? 'threshold'
              : 'pattern'}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-text-muted">
          <span>{service}</span>
          <span className={severity}>
            {alert.metricValue} / {alert.thresholdValue} ({ratio.toFixed(1)}x)
          </span>
          {alert.channelsNotified.length > 0 && (
            <span>
              {alert.channelsNotified.length} channel{alert.channelsNotified.length > 1 ? 's' : ''}{' '}
              notified
            </span>
          )}
        </div>
      </div>

      {/* Timestamp */}
      <span className="text-[10px] text-text-muted shrink-0 font-mono">
        {new Date(alert.firedAt).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create Rule Form
// ---------------------------------------------------------------------------

function CreateRuleForm({ onClose }: { onClose: () => void }) {
  const createMutation = useCreateRule()
  const { data: servicesResponse } = useServices()
  const services = servicesResponse?.data ?? []
  const [name, setName] = useState('')
  const [service, setService] = useState(services[0]?.service ?? '')
  const [metric, setMetric] = useState<'error_count' | 'warn_count' | 'log_count'>('error_count')
  const [operator, setOperator] = useState<'>' | '>=' | '<' | '<='>('>')
  const [value, setValue] = useState(10)
  const [windowMinutes, setWindowMinutes] = useState(5)
  const [environment, setEnvironment] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const envSuffix = environment ? ` (${environment})` : ''
    createMutation.mutate(
      {
        name: name || `${metric.replace('_', ' ')} ${operator} ${value} — ${service}${envSuffix}`,
        ruleType: 'threshold',
        config: {
          metric,
          service,
          operator,
          value,
          windowMinutes,
          ...(environment ? { environment } : {}),
        },
      },
      {
        onSuccess: () => {
          toast.success('Rule created')
          onClose()
        },
        onError: () => toast.error('Failed to create rule'),
      },
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="p-4 border-b border-border-subtle/50 space-y-3 bg-surface-base/50"
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-[10px] text-text-muted uppercase">Name (optional)</span>
          <input
            className="w-full rounded-md border border-border-subtle bg-surface-card px-2 py-1.5 text-xs text-text-primary"
            placeholder="Auto-generated if empty"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] text-text-muted uppercase">Service</span>
          <select
            className="w-full rounded-md border border-border-subtle bg-surface-card px-2 py-1.5 text-xs text-text-primary"
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            {services.map((s) => (
              <option key={s.service} value={s.service}>
                {s.service}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[10px] text-text-muted uppercase">Environment (optional)</span>
          <input
            className="w-full rounded-md border border-border-subtle bg-surface-card px-2 py-1.5 text-xs text-text-primary"
            placeholder="e.g. production, staging"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] text-text-muted uppercase">Metric</span>
          <select
            className="w-full rounded-md border border-border-subtle bg-surface-card px-2 py-1.5 text-xs text-text-primary"
            value={metric}
            onChange={(e) => setMetric(e.target.value as typeof metric)}
          >
            <option value="error_count">Error count</option>
            <option value="warn_count">Warning count</option>
            <option value="log_count">Log count</option>
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-1">
            <span className="text-[10px] text-text-muted uppercase">Op</span>
            <select
              className="w-full rounded-md border border-border-subtle bg-surface-card px-2 py-1.5 text-xs text-text-primary"
              value={operator}
              onChange={(e) => setOperator(e.target.value as typeof operator)}
            >
              <option value=">">&gt;</option>
              <option value=">=">&gt;=</option>
              <option value="<">&lt;</option>
              <option value="<=">&lt;=</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-text-muted uppercase">Value</span>
            <input
              type="number"
              className="w-full rounded-md border border-border-subtle bg-surface-card px-2 py-1.5 text-xs text-text-primary"
              value={value}
              min={1}
              onChange={(e) => setValue(Number(e.target.value))}
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-text-muted uppercase">Window</span>
            <select
              className="w-full rounded-md border border-border-subtle bg-surface-card px-2 py-1.5 text-xs text-text-primary"
              value={windowMinutes}
              onChange={(e) => setWindowMinutes(Number(e.target.value))}
            >
              <option value={1}>1min</option>
              <option value={5}>5min</option>
              <option value={15}>15min</option>
              <option value={30}>30min</option>
              <option value={60}>60min</option>
            </select>
          </label>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          className="text-xs"
          disabled={createMutation.isPending}
        >
          Create Rule
        </Button>
        <Button type="button" variant="ghost" className="text-xs" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AlertsPage() {
  const [filters, setFilters] = useState<Record<string, string | undefined>>({})
  const [showCreateForm, setShowCreateForm] = useState(false)
  const {
    data: rulesResponse,
    isLoading: rulesLoading,
    isError: rulesError,
    refetch: refetchRules,
  } = useRules()
  const {
    data: alertsResponse,
    isLoading: alertsLoading,
    isError: alertsError,
    refetch: refetchAlerts,
  } = useAlerts()

  const rules = rulesResponse?.data ?? []
  const alerts = alertsResponse?.data ?? []

  // Derive filter options from live data
  const filterDefs: FilterDefinition[] = useMemo(() => {
    const services = [
      ...new Set(
        rules.flatMap((r) => {
          if (isThresholdConfig(r)) return [r.config.service]
          return []
        }),
      ),
    ]

    return [
      {
        key: 'type',
        label: 'Type',
        options: [
          { value: 'threshold', label: 'Threshold' },
          { value: 'template_watch', label: 'Pattern' },
        ],
      },
      ...(services.length > 0
        ? [
            {
              key: 'service',
              label: 'Service',
              options: services.map((s) => ({ value: s, label: s })),
            },
          ]
        : []),
      {
        key: 'status',
        label: 'Status',
        options: [
          { value: 'enabled', label: 'Enabled' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
    ]
  }, [rules])

  const filteredRules = rules.filter((r) => {
    if (filters.type && r.ruleType !== filters.type) return false
    if (filters.service && isThresholdConfig(r) && r.config.service !== filters.service)
      return false
    if (filters.status === 'enabled' && !r.enabled) return false
    if (filters.status === 'disabled' && r.enabled) return false
    return true
  })

  const enabledCount = rules.filter((r) => r.enabled).length
  const recentAlerts = alerts.filter(
    (a) => Date.now() - new Date(a.firedAt).getTime() < 24 * 60 * 60 * 1000,
  )

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Alert Rules</h2>
          <p className="text-xs text-text-muted mt-0.5">
            {enabledCount} active rule{enabledCount !== 1 ? 's' : ''} · {recentAlerts.length} alert
            {recentAlerts.length !== 1 ? 's' : ''} in the last 24h
          </p>
        </div>
        <Button
          variant="primary"
          className="text-xs"
          onClick={() => setShowCreateForm(!showCreateForm)}
        >
          <Plus size={14} className="mr-1" />
          Create Rule
        </Button>
      </div>

      {/* Active Rules */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Rules ({rules.length})</span>
            <div className="flex items-center gap-2 text-[11px] font-normal text-text-muted">
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-success" />
                {enabledCount} enabled
              </span>
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-surface-base border border-border" />
                {rules.length - enabledCount} disabled
              </span>
            </div>
          </CardTitle>
        </CardHeader>
        {showCreateForm && <CreateRuleForm onClose={() => setShowCreateForm(false)} />}
        <div className="px-4 py-2 border-b border-border-subtle/50">
          <FilterBar
            definitions={filterDefs}
            values={filters}
            onChange={(key, value) => setFilters((prev) => ({ ...prev, [key]: value }))}
          />
        </div>
        <CardContent className="p-0">
          {rulesLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : rulesError ? (
            <div className="p-4">
              <QueryError onRetry={() => refetchRules()} />
            </div>
          ) : filteredRules.length === 0 ? (
            <p className="text-xs text-text-muted py-8 text-center">
              {rules.length === 0
                ? 'No rules configured. Create one from the service health cards or pattern detail panel.'
                : 'No rules match the current filters.'}
            </p>
          ) : (
            filteredRules.map((rule) => <RuleRow key={rule.ruleId} rule={rule} />)
          )}
        </CardContent>
      </Card>

      {/* Alert History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Alert History</span>
            <span className="text-[11px] font-normal text-text-muted">Last 7 days</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {alertsLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : alertsError ? (
            <div className="p-4">
              <QueryError onRetry={() => refetchAlerts()} />
            </div>
          ) : alerts.length === 0 ? (
            <p className="text-xs text-text-muted py-8 text-center">
              No alerts have fired yet. Create rules to start monitoring.
            </p>
          ) : (
            alerts.map((alert) => <AlertHistoryRow key={alert.alertId} alert={alert} />)
          )}
        </CardContent>
      </Card>

      {/* Tip */}
      <p className="text-[11px] text-text-muted text-center">
        Create rules from the pattern detail panel ("Watch Pattern") or service health cards ("Alert
        on Service").
      </p>
    </div>
  )
}
