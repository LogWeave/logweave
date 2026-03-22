/**
 * Alerts Page MOCKUP — static UI for design review.
 * No API calls, hardcoded sample data. Will be wired up after approval.
 */

import { useState } from 'react'
import { Bell, BellOff, Hash, Activity, Clock, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { type FilterDefinition, FilterBar } from '../../components/ui/filter-bar'
import { cn } from '../../lib/cn'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_RULES = [
  {
    id: 'rule-1',
    name: 'Payment timeout spike',
    type: 'template_watch' as const,
    service: 'payments-api',
    condition: 'Anomaly score > 1.0x baseline',
    templateText: 'Connection to <*> timed out after <*>ms',
    enabled: true,
    channels: ['#payments-alerts'],
    lastFired: '2 hours ago',
  },
  {
    id: 'rule-2',
    name: 'High error rate — payments',
    type: 'threshold' as const,
    service: 'payments-api',
    condition: 'Error count > 10 / 5 min',
    enabled: true,
    channels: ['#payments-alerts', '#oncall'],
    lastFired: '45 min ago',
  },
  {
    id: 'rule-3',
    name: 'Auth failures spike',
    type: 'template_watch' as const,
    service: 'auth-api',
    condition: 'Anomaly score > 1.0x baseline',
    templateText: 'Failed login attempt for user <*> from <IP>',
    enabled: true,
    channels: ['#security'],
    lastFired: 'Never',
  },
  {
    id: 'rule-4',
    name: 'Gateway 500s',
    type: 'threshold' as const,
    service: 'api-gateway',
    condition: 'Status 500 count > 5 / 5 min',
    enabled: false,
    channels: [],
    lastFired: '3 days ago',
  },
  {
    id: 'rule-5',
    name: 'Notification delivery failures',
    type: 'threshold' as const,
    service: 'notifications-svc',
    condition: 'Error rate > 5% / 15 min',
    enabled: true,
    channels: ['#platform'],
    lastFired: 'Never',
  },
]

const SAMPLE_HISTORY = [
  {
    id: 'alert-1',
    ruleName: 'High error rate — payments',
    ruleType: 'threshold' as const,
    service: 'payments-api',
    firedAt: '2026-03-22 04:15:00',
    metricValue: 23,
    thresholdValue: 10,
    channels: ['#payments-alerts', '#oncall'],
  },
  {
    id: 'alert-2',
    ruleName: 'Payment timeout spike',
    ruleType: 'template_watch' as const,
    service: 'payments-api',
    firedAt: '2026-03-22 02:30:00',
    metricValue: 3.2,
    thresholdValue: 1.0,
    channels: ['#payments-alerts'],
  },
  {
    id: 'alert-3',
    ruleName: 'High error rate — payments',
    ruleType: 'threshold' as const,
    service: 'payments-api',
    firedAt: '2026-03-22 01:45:00',
    metricValue: 15,
    thresholdValue: 10,
    channels: ['#payments-alerts', '#oncall'],
  },
  {
    id: 'alert-4',
    ruleName: 'Gateway 500s',
    ruleType: 'threshold' as const,
    service: 'api-gateway',
    firedAt: '2026-03-19 14:20:00',
    metricValue: 8,
    thresholdValue: 5,
    channels: ['#platform'],
  },
]

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function RuleRow({ rule }: { rule: typeof SAMPLE_RULES[0] }) {
  return (
    <div className={cn(
      'flex items-center gap-3 py-3 px-4 border-b border-border-subtle/50 last:border-0',
      !rule.enabled && 'opacity-50',
    )}>
      {/* Status indicator */}
      <button
        type="button"
        className={cn(
          'shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors',
          rule.enabled
            ? 'bg-success/10 text-success hover:bg-success/20'
            : 'bg-surface-base text-text-muted hover:bg-surface-elevated',
        )}
        title={rule.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
      >
        {rule.enabled ? <Bell size={14} /> : <BellOff size={14} />}
      </button>

      {/* Rule info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-text-primary truncate">{rule.name}</span>
          <Badge variant={rule.type === 'threshold' ? 'spike' : 'new'}>
            {rule.type === 'threshold' ? 'threshold' : 'pattern'}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <Activity size={10} />
            {rule.service}
          </span>
          <span>{rule.condition}</span>
          <span className="flex items-center gap-1">
            <Clock size={10} />
            Last fired: {rule.lastFired}
          </span>
        </div>
      </div>

      {/* Channels */}
      <div className="flex items-center gap-1 shrink-0">
        {rule.channels.length > 0 ? (
          rule.channels.map((ch) => (
            <span
              key={ch}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-base text-[10px] text-text-muted"
            >
              <Hash size={8} />
              {ch.replace('#', '')}
            </span>
          ))
        ) : (
          <span className="text-[10px] text-text-muted italic">No channels</span>
        )}
        <Button variant="ghost" className="ml-1 h-6 w-6 p-0">
          <Plus size={12} />
        </Button>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" className="h-6 w-6 p-0 text-text-muted hover:text-danger">
          <Trash2 size={12} />
        </Button>
        <ChevronRight size={14} className="text-text-muted" />
      </div>
    </div>
  )
}

function AlertHistoryRow({ alert }: { alert: typeof SAMPLE_HISTORY[0] }) {
  const ratio = alert.metricValue / alert.thresholdValue
  const severity = ratio > 3 ? 'text-danger' : ratio > 1.5 ? 'text-warning' : 'text-text-primary'

  return (
    <div className="flex items-center gap-3 py-2.5 px-4 border-b border-border-subtle/50 last:border-0">
      {/* Severity dot */}
      <div className={cn(
        'shrink-0 w-2 h-2 rounded-full',
        ratio > 3 ? 'bg-danger' : ratio > 1.5 ? 'bg-warning' : 'bg-info',
      )} />

      {/* Alert info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium text-text-primary truncate">{alert.ruleName}</span>
          <Badge variant={alert.ruleType === 'threshold' ? 'spike' : 'new'}>
            {alert.ruleType === 'threshold' ? 'threshold' : 'pattern'}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-text-muted">
          <span>{alert.service}</span>
          <span className={severity}>
            {alert.metricValue} / {alert.thresholdValue} ({ratio.toFixed(1)}x)
          </span>
          <span>
            → {alert.channels.join(', ')}
          </span>
        </div>
      </div>

      {/* Timestamp */}
      <span className="text-[10px] text-text-muted shrink-0 font-mono">
        {new Date(alert.firedAt).toLocaleString([], {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const RULE_FILTER_DEFS: FilterDefinition[] = [
  {
    key: 'type',
    label: 'Type',
    options: [
      { value: 'threshold', label: 'Threshold' },
      { value: 'template_watch', label: 'Pattern' },
    ],
  },
  {
    key: 'service',
    label: 'Service',
    options: [
      ...new Set(SAMPLE_RULES.map((r) => r.service)),
    ].map((s) => ({ value: s, label: s })),
  },
  {
    key: 'status',
    label: 'Status',
    options: [
      { value: 'enabled', label: 'Enabled' },
      { value: 'disabled', label: 'Disabled' },
    ],
  },
]

export function AlertsPage() {
  const [filters, setFilters] = useState<Record<string, string | undefined>>({})

  const filteredRules = SAMPLE_RULES.filter((r) => {
    if (filters.type && r.type !== filters.type) return false
    if (filters.service && r.service !== filters.service) return false
    if (filters.status === 'enabled' && !r.enabled) return false
    if (filters.status === 'disabled' && r.enabled) return false
    return true
  })

  const enabledCount = SAMPLE_RULES.filter((r) => r.enabled).length
  const recentAlerts = SAMPLE_HISTORY.filter(
    (a) => Date.now() - new Date(a.firedAt).getTime() < 24 * 60 * 60 * 1000,
  )

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Alert Rules</h2>
          <p className="text-xs text-text-muted mt-0.5">
            {enabledCount} active rules · {recentAlerts.length} alerts in the last 24h
          </p>
        </div>
      </div>

      {/* Active Rules */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Rules ({SAMPLE_RULES.length})</span>
            <div className="flex items-center gap-2 text-[11px] font-normal text-text-muted">
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-success" />
                {enabledCount} enabled
              </span>
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-surface-base border border-border" />
                {SAMPLE_RULES.length - enabledCount} disabled
              </span>
            </div>
          </CardTitle>
        </CardHeader>
        <div className="px-4 py-2 border-b border-border-subtle/50">
          <FilterBar
            definitions={RULE_FILTER_DEFS}
            values={filters}
            onChange={(key, value) => setFilters((prev) => ({ ...prev, [key]: value }))}
          />
        </div>
        <CardContent className="p-0">
          {filteredRules.length === 0 ? (
            <p className="text-xs text-text-muted py-8 text-center">
              No rules match the current filters.
            </p>
          ) : (
            filteredRules.map((rule) => (
              <RuleRow key={rule.id} rule={rule} />
            ))
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
          {SAMPLE_HISTORY.length === 0 ? (
            <p className="text-xs text-text-muted py-8 text-center">
              No alerts have fired yet. Create rules to start monitoring.
            </p>
          ) : (
            SAMPLE_HISTORY.map((alert) => (
              <AlertHistoryRow key={alert.id} alert={alert} />
            ))
          )}
        </CardContent>
      </Card>

      {/* Tip */}
      <p className="text-[11px] text-text-muted text-center">
        Create rules from the pattern detail panel ("Watch Pattern") or service health cards ("Alert on Service").
      </p>
    </div>
  )
}
