/**
 * UX Mockups Page — throwaway component for visual comparison.
 * Navigate to /mockups to see all options side by side.
 */

import { Activity, AlertTriangle, ArrowUpRight, Bell, Layers, Server, Sparkles, Zap } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SERVICES = [
  { name: 'api-gateway', events: 2792, errorRate: 3.7, newPatterns: 37 },
  { name: 'payments-api', events: 1059, errorRate: 2.3, newPatterns: 43 },
  { name: 'auth-api', events: 953, errorRate: 2.4, newPatterns: 102 },
  { name: 'notifications-svc', events: 543, errorRate: 0.4, newPatterns: 26 },
]

const PATTERNS = [
  { text: 'GET <*> -> <*> <*> in <*> <*> req, <*> resp)', service: 'api-gateway', count: 42, errors: 3, isNew: true },
  { text: 'POST <*> -> <*> in <*> <*> req, <*> resp)', service: 'api-gateway', count: 38, errors: 5, isNew: true },
  { text: 'User <*> authenticated successfully via <*> from <*>', service: 'auth-api', count: 31, errors: 0, isNew: true },
  { text: 'Payment processed: <*> <*> USD via <*> <*> <*>', service: 'payments-api', count: 24, errors: 2, isNew: true },
  { text: 'Email sent: <*> to <EMAIL> via <*> in <*>', service: 'notifications-svc', count: 18, errors: 0, isNew: true },
  { text: 'Token refreshed for session <UUID> — new TTL <*>', service: 'auth-api', count: 15, errors: 1, isNew: false },
  { text: 'Webhook delivered to <*> — status <*> in <*>', service: 'payments-api', count: 12, errors: 0, isNew: false },
  { text: 'Rate limit exceeded: <EMAIL> — <*> capped at <*>', service: 'notifications-svc', count: 9, errors: 3, isNew: true },
]

const KPIS = [
  { label: 'Events', value: '4,611', trend: '+14.3%', icon: Activity, variant: 'default' as const },
  { label: 'Patterns', value: '104', trend: '+2.0%', icon: Layers, variant: 'default' as const },
  { label: 'New Today', value: '258', trend: '+100%', icon: Sparkles, variant: 'warning' as const },
  { label: 'Unclustered', value: '0', trend: 'stable', icon: AlertTriangle, variant: 'default' as const },
  { label: 'Error Rate', value: '2.6%', trend: '+1.2pp', icon: AlertTriangle, variant: 'danger' as const },
  { label: 'Spikes', value: '0', trend: 'stable', icon: Zap, variant: 'default' as const },
]

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4 pb-3 border-b border-border-subtle">
      <h2 className="text-lg font-bold text-text-primary">{title}</h2>
      <p className="text-xs text-text-muted mt-1">{description}</p>
    </div>
  )
}

// ===========================================================================
// KPI STRIP MOCKUPS
// ===========================================================================

type Kpi = (typeof KPIS)[number]
const HERO_KPIS: Kpi[] = [KPIS[5], KPIS[4], KPIS[0]].filter(Boolean) as Kpi[]
const SECONDARY_KPIS: Kpi[] = [KPIS[1], KPIS[2], KPIS[3]].filter(Boolean) as Kpi[]

function KpiOptionA() {
  return (
    <div className="space-y-3">
      {/* Primary row — 3 hero metrics */}
      <div className="grid grid-cols-3 gap-3">
        {HERO_KPIS.map((kpi) => (
          <Card key={kpi.label}>
            <div className="flex items-center gap-3">
              <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${kpi.variant === 'danger' ? 'bg-red-500/10 text-danger' : kpi.variant === 'warning' ? 'bg-amber-500/10 text-warning' : 'bg-brand-500/10 text-brand-400'}`}>
                <kpi.icon size={20} />
              </div>
              <div>
                <p className="text-[10px] text-text-muted uppercase tracking-wider">{kpi.label}</p>
                <p className="text-xl font-bold font-mono tabular-nums text-text-primary">{kpi.value}</p>
              </div>
              <div className="ml-auto text-right">
                <span className="text-xs text-success flex items-center gap-0.5">
                  <ArrowUpRight size={10} /> {kpi.trend}
                </span>
                <span className="text-[9px] text-text-muted">vs prev 1h</span>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {/* Secondary row — compact pills */}
      <div className="flex items-center gap-3">
        {SECONDARY_KPIS.map((kpi) => (
          <div key={kpi.label} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-base border border-border-subtle">
            <kpi.icon size={12} className="text-text-muted" />
            <span className="text-[10px] text-text-muted uppercase">{kpi.label}</span>
            <span className="text-sm font-bold font-mono text-text-primary">{kpi.value}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-500/5 border border-brand-500/20">
          <span className="text-[10px] text-brand-400 font-medium">44:1 compression</span>
        </div>
      </div>
    </div>
  )
}

function KpiOptionB() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {KPIS.map((kpi) => (
        <div key={kpi.label} className="rounded-lg border border-border-subtle bg-surface-card p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">{kpi.label}</span>
            <kpi.icon size={14} className={kpi.variant === 'danger' ? 'text-danger' : kpi.variant === 'warning' ? 'text-warning' : 'text-text-muted'} />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-text-primary">{kpi.value}</p>
          <p className="text-[10px] text-success mt-1">{kpi.trend}</p>
        </div>
      ))}
    </div>
  )
}

function KpiOptionC() {
  return (
    <Card>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">System Overview</span>
        <span className="text-[10px] text-text-muted">Last 1h</span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 divide-x divide-border-subtle">
        {KPIS.map((kpi) => (
          <div key={kpi.label} className="px-4 py-3 text-center">
            <p className="text-[9px] text-text-muted uppercase tracking-wider mb-1">{kpi.label}</p>
            <p className="text-lg font-bold font-mono tabular-nums text-text-primary">{kpi.value}</p>
            <p className="text-[9px] text-success mt-0.5">{kpi.trend}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ===========================================================================
// SERVICE CARDS MOCKUPS
// ===========================================================================

function ServicesOptionA() {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">Services</h3>
      {SERVICES.map((svc) => (
        <Card key={svc.name} variant="interactive">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-brand-500/10 text-brand-400">
              <Server size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary truncate">{svc.name}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-text-muted font-mono tabular-nums">{svc.events.toLocaleString()}</span>
                <span className="text-xs text-danger font-mono tabular-nums">{svc.errorRate}%</span>
              </div>
            </div>
            <Badge variant="new" className="shrink-0">{svc.newPatterns} new</Badge>
            <button type="button" className="shrink-0 h-7 w-7 rounded-md flex items-center justify-center text-text-muted hover:text-brand-400">
              <Bell size={14} />
            </button>
          </div>
        </Card>
      ))}
    </div>
  )
}

function ServicesOptionB() {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">Services</h3>
      <div className="grid grid-cols-2 gap-2">
        {SERVICES.map((svc) => (
          <Card key={svc.name} variant="interactive">
            <div className="text-center">
              <p className="text-sm font-medium text-text-primary">{svc.name}</p>
              <div className="flex items-center justify-center gap-3 mt-2">
                <div>
                  <p className="text-lg font-bold font-mono tabular-nums text-text-primary">{svc.events.toLocaleString()}</p>
                  <p className="text-[9px] text-text-muted">events</p>
                </div>
                <div className="h-8 w-px bg-border-subtle" />
                <div>
                  <p className="text-lg font-bold font-mono tabular-nums text-danger">{svc.errorRate}%</p>
                  <p className="text-[9px] text-text-muted">errors</p>
                </div>
              </div>
              {svc.newPatterns > 0 && (
                <Badge variant="new" className="mt-2">{svc.newPatterns} new</Badge>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

function ServicesOptionC() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Services</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {SERVICES.map((svc, i) => (
          <div key={svc.name} className={`flex items-center gap-3 px-4 py-3 hover:bg-surface-elevated transition-colors ${i < SERVICES.length - 1 ? 'border-b border-border-subtle/50' : ''}`}>
            <div className={`h-2 w-2 rounded-full shrink-0 ${svc.errorRate > 2 ? 'bg-danger' : 'bg-success'}`} />
            <span className="text-sm font-medium text-text-primary flex-1">{svc.name}</span>
            <span className="text-xs text-text-muted font-mono tabular-nums">{svc.events.toLocaleString()}</span>
            <span className="text-xs text-danger font-mono tabular-nums w-12 text-right">{svc.errorRate}%</span>
            {svc.newPatterns > 0 && <Badge variant="new" className="shrink-0">{svc.newPatterns}</Badge>}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

// ===========================================================================
// PATTERNS MOCKUPS
// ===========================================================================

function PatternsOptionA() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Patterns (card layout)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {PATTERNS.slice(0, 5).map((p) => (
          <div key={p.text} className="p-3 rounded-lg bg-surface-base hover:bg-surface-elevated transition-colors cursor-pointer">
            <div className="flex items-start gap-2">
              <code className="text-xs font-mono text-text-primary flex-1 leading-relaxed">{p.text}</code>
              {p.isNew && <Badge variant="new" className="shrink-0">NEW</Badge>}
            </div>
            <div className="flex items-center gap-3 mt-2 text-[10px] text-text-muted">
              <span className="text-brand-400">{p.service}</span>
              <span>{p.count} occurrences</span>
              {p.errors > 0 && <span className="text-danger">{p.errors} errors</span>}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function PatternsOptionB() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Patterns (compact list)</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {PATTERNS.slice(0, 6).map((p, i) => (
          <div key={p.text} className={`flex items-center gap-3 px-4 py-2.5 hover:bg-surface-elevated transition-colors cursor-pointer ${i < 5 ? 'border-b border-border-subtle/50' : ''}`}>
            <div className="flex-1 min-w-0">
              <code className="text-xs font-mono text-text-primary truncate block">{p.text}</code>
              <span className="text-[10px] text-brand-400">{p.service}</span>
            </div>
            <span className="text-xs font-mono tabular-nums text-text-muted shrink-0">{p.count}</span>
            {p.errors > 0 && <span className="text-xs font-mono tabular-nums text-danger shrink-0">{p.errors}</span>}
            {p.isNew && <Badge variant="new" className="shrink-0 text-[9px]">NEW</Badge>}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function PatternsOptionC() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Patterns (grouped by service)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {['api-gateway', 'auth-api', 'payments-api'].map((service) => {
          const servicePatterns = PATTERNS.filter((p) => p.service === service)
          return (
            <div key={service}>
              <div className="flex items-center gap-2 mb-2">
                <div className="h-2 w-2 rounded-full bg-brand-400" />
                <span className="text-xs font-medium text-text-primary">{service}</span>
                <span className="text-[10px] text-text-muted">{servicePatterns.length} patterns</span>
              </div>
              <div className="space-y-1 pl-4 border-l border-border-subtle">
                {servicePatterns.map((p) => (
                  <div key={p.text} className="flex items-center gap-2 py-1 hover:bg-surface-elevated rounded px-2 -mx-2 cursor-pointer">
                    <code className="text-[11px] font-mono text-text-secondary truncate flex-1">{p.text}</code>
                    <span className="text-[10px] font-mono text-text-muted shrink-0">{p.count}</span>
                    {p.isNew && <Badge variant="new" className="shrink-0 text-[9px]">NEW</Badge>}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ===========================================================================
// MOCKUPS PAGE
// ===========================================================================

export function MockupsPage() {
  return (
    <div className="space-y-12 max-w-5xl pb-20">
      <div>
        <h1 className="text-2xl font-bold text-text-primary mb-1">UX Mockups</h1>
        <p className="text-sm text-text-muted">Compare options side by side. Resize your browser to see responsive behavior.</p>
      </div>

      {/* KPI STRIP */}
      <section>
        <SectionHeader title="KPI Strip" description="Option A: Priority tier (hero + pills). Option B: Simple grid. Option C: Single card with dividers." />
        <div className="space-y-8">
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option A — Priority Tier</p>
            <KpiOptionA />
          </div>
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option B — Simple Grid</p>
            <KpiOptionB />
          </div>
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option C — Unified Card with Dividers</p>
            <KpiOptionC />
          </div>
        </div>
      </section>

      {/* SERVICE CARDS */}
      <section>
        <SectionHeader title="Service Cards" description="Option A: Vertical stack (current style, fixed). Option B: 2-column grid. Option C: Compact table rows." />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option A — Stack</p>
            <ServicesOptionA />
          </div>
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option B — Grid</p>
            <ServicesOptionB />
          </div>
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option C — Table Rows</p>
            <ServicesOptionC />
          </div>
        </div>
      </section>

      {/* PATTERNS */}
      <section>
        <SectionHeader title="Patterns" description="Option A: Cards with metadata below. Option B: Compact list (like current but responsive). Option C: Grouped by service." />
        <div className="space-y-8">
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option A — Cards</p>
            <PatternsOptionA />
          </div>
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option B — Compact List</p>
            <PatternsOptionB />
          </div>
          <div>
            <p className="text-xs text-brand-400 font-medium mb-2">Option C — Grouped by Service</p>
            <PatternsOptionC />
          </div>
        </div>
      </section>
    </div>
  )
}
