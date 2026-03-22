import { Bell, BellRing, X } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import {
  useSlackSettings,
  useSparklines,
  useTemplateStatusCodes,
  useTemplates,
  useUnwatchTemplate,
  useWatches,
  useWatchTemplate,
} from '../../api/queries'
import type { TemplateRow } from '../../api/types'
import { Chart } from '../../components/chart'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { StatBox } from '../../components/ui/stat-box'
import { InfoTooltip, Tooltip } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { TOOLTIPS } from '../../lib/tooltips'
import { useDashboardStore } from '../../stores/dashboard-store'

function TemplateText({ text }: { text: string }) {
  // Highlight {placeholders} in the template
  const parts = text.split(/(\{[^}]+\})/)
  return (
    <code className="text-xs font-mono text-text-primary leading-relaxed">
      {parts.map((part, i) => {
        const key = `${part}-${i}`
        if (part.startsWith('{') && part.endsWith('}')) {
          return (
            <Tooltip key={key} content={TOOLTIPS.templatePlaceholder}>
              <span className="px-1 py-0.5 mx-0.5 rounded bg-brand-500/10 text-brand-400 text-[11px] cursor-help">
                {part}
              </span>
            </Tooltip>
          )
        }
        return <span key={key}>{part}</span>
      })}
    </code>
  )
}

function DetailContent({ template }: { template: TemplateRow }) {
  const { data: sparklineResponse } = useSparklines([template.templateId])
  const sparklinePoints = sparklineResponse?.data?.[template.templateId] ?? []
  const { data: statusCodeResponse } = useTemplateStatusCodes(template.templateId)
  const statusCodes = statusCodeResponse?.data ?? []
  const { data: watchesResponse } = useWatches()
  const watchedIds = watchesResponse?.data ?? []
  const isWatched = watchedIds.some((w) => w.templateId === template.templateId)
  const watchMutation = useWatchTemplate()
  const unwatchMutation = useUnwatchTemplate()
  const { data: slackResponse } = useSlackSettings()
  const slackConfigured = slackResponse?.data?.configured ?? false
  const investigatingStatusCode = useDashboardStore((s) => s.investigatingStatusCode)
  const setInvestigatingStatusCode = useDashboardStore((s) => s.setInvestigatingStatusCode)
  const selectedTimeRange = useDashboardStore((s) => s.selectedTimeRange)
  const setSelectedTimeRange = useDashboardStore((s) => s.setSelectedTimeRange)

  const sparklineClickHandler = useMemo(() => ({
    click: (params: unknown) => {
      const p = params as { dataIndex?: number }
      const point = p.dataIndex != null ? sparklinePoints[p.dataIndex] : undefined
      if (point) {
        const start = point.intervalStart
        const end = new Date(new Date(start).getTime() + 5 * 60_000).toISOString()
        setSelectedTimeRange(
          selectedTimeRange?.start === start ? null : { start, end },
        )
      }
    },
  }), [sparklinePoints, selectedTimeRange, setSelectedTimeRange])

  return (
    <div className="space-y-5">
      {/* Template text with highlighted placeholders */}
      <div>
        <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
          Pattern
        </h4>
        <div className="bg-surface-base rounded-[var(--radius-md)] p-3 whitespace-pre-wrap break-all">
          <TemplateText text={template.templateText} />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatBox label="Occurrences" value={template.occurrenceCount.toLocaleString()} />
        <StatBox
          label="Errors"
          value={template.errorCount.toLocaleString()}
          valueClassName={template.errorCount > 0 ? 'text-danger' : undefined}
        />
        <StatBox
          label={
            <span className="flex items-center gap-1">
              Avg Duration <InfoTooltip content={TOOLTIPS.avgDuration} />
            </span>
          }
          value={`${template.avgDurationMs.toFixed(1)}ms`}
        />
        <StatBox
          label={
            <span className="flex items-center gap-1">
              Anomaly Score <InfoTooltip content={TOOLTIPS.anomalyScore} />
            </span>
          }
          value={
            <span>
              {template.maxAnomalyScore.toFixed(2)}{' '}
              <span className="text-[10px] font-normal uppercase tracking-wide">
                {template.maxAnomalyScore > 1
                  ? 'Anomalous'
                  : template.maxAnomalyScore > 0.5
                    ? 'Elevated'
                    : 'Normal'}
              </span>
            </span>
          }
          valueClassName={
            template.maxAnomalyScore > 1
              ? 'text-danger'
              : template.maxAnomalyScore > 0.5
                ? 'text-warning'
                : undefined
          }
        />
      </div>

      {/* Status code breakdown */}
      {statusCodes.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
            Status Codes
          </h4>
          <div className="space-y-1.5">
            {statusCodes.map((sc) => {
              const maxCount = statusCodes[0]?.count ?? 1
              const pct = (sc.count / maxCount) * 100
              const color =
                sc.statusCode >= 500
                  ? 'bg-danger'
                  : sc.statusCode >= 400
                    ? 'bg-warning'
                    : sc.statusCode >= 300
                      ? 'bg-info'
                      : 'bg-success'
              return (
                <button
                  type="button"
                  key={sc.statusCode}
                  className={cn(
                    'flex items-center gap-2 text-xs w-full rounded-[var(--radius-sm)] px-1 py-0.5 -mx-1 transition-colors text-left',
                    investigatingStatusCode === sc.statusCode
                      ? 'bg-brand-500/20 ring-1 ring-brand-500/40'
                      : 'hover:bg-surface-elevated/50 cursor-pointer',
                  )}
                  onClick={() => setInvestigatingStatusCode(
                    investigatingStatusCode === sc.statusCode ? null : sc.statusCode,
                  )}
                >
                  <span className="font-mono text-text-primary w-8 text-right tabular-nums">
                    {sc.statusCode}
                  </span>
                  <div className="flex-1 h-4 bg-surface-base rounded-[var(--radius-sm)] overflow-hidden">
                    <div
                      className={cn(color, 'h-full rounded-[var(--radius-sm)] transition-all')}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                  <span className="font-mono text-text-muted tabular-nums w-14 text-right">
                    {sc.count.toLocaleString()}
                  </span>
                  <span className="text-text-muted text-[10px]">›</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Investigation panel — shown when a status code is clicked */}
      {investigatingStatusCode != null && (
        <div className="bg-surface-base rounded-[var(--radius-md)] p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
              Events — {investigatingStatusCode}
              {selectedTimeRange && (
                <span className="text-brand-400 normal-case ml-1">
                  ({new Date(selectedTimeRange.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                </span>
              )}
            </h4>
            <button
              type="button"
              className="text-[10px] text-text-muted hover:text-text-primary"
              onClick={() => setInvestigatingStatusCode(null)}
            >
              Close ×
            </button>
          </div>
          <p className="text-[11px] text-text-muted">
            Use MCP tool: <code className="text-brand-400">template_events</code> with template_id and status_code={investigatingStatusCode} for detailed event data with trace IDs.
          </p>
        </div>
      )}

      {/* Metadata */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted">Service</span>
          <span className="text-text-primary">{template.service}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted">Pattern ID</span>
          <button
            type="button"
            className="font-mono text-text-primary hover:text-brand-400 transition-colors cursor-pointer"
            title="Click to copy full ID"
            onClick={() => {
              navigator.clipboard.writeText(template.templateId)
              toast.success('Pattern ID copied')
            }}
          >
            {template.templateId.slice(0, 16)}...
          </button>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted">First seen</span>
          <span className="font-mono text-text-primary">
            {new Date(template.firstSeen).toLocaleString()}
            {template.isNewToday && (
              <Badge variant="new" className="ml-2">
                new
              </Badge>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted">Last seen</span>
          <span className="font-mono text-text-primary">
            {new Date(template.lastSeen).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Sparkline history */}
      {sparklinePoints.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
            Occurrence History ({sparklinePoints.length} points)
            <InfoTooltip content={TOOLTIPS.occurrenceHistory} />
          </h4>
          {selectedTimeRange && (
            <button
              type="button"
              className="text-[10px] text-brand-400 hover:text-brand-300 mb-1"
              onClick={() => setSelectedTimeRange(null)}
            >
              Clear selection ×
            </button>
          )}
          <div className="bg-surface-base rounded-[var(--radius-md)] p-2">
            <Chart
              option={{
                grid: { left: 40, right: 8, top: 8, bottom: 24, containLabel: false },
                xAxis: {
                  type: 'category',
                  data: sparklinePoints.map((p) => {
                    const d = new Date(p.intervalStart)
                    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
                  }),
                  axisLabel: { fontSize: 10 },
                },
                yAxis: { type: 'value', splitNumber: 3, axisLabel: { fontSize: 10 } },
                series: [
                  {
                    type: 'bar',
                    data: sparklinePoints.map((p) => ({
                      value: p.count,
                      itemStyle: selectedTimeRange && p.intervalStart !== selectedTimeRange.start
                        ? { color: 'var(--color-brand-400)', opacity: 0.2 }
                        : { color: 'var(--color-brand-400)', borderRadius: [2, 2, 0, 0] },
                    })),
                    cursor: 'pointer',
                  },
                ],
                tooltip: { trigger: 'axis' },
                animationDuration: 300,
              }}
              height={140}
              onEvents={sparklineClickHandler}
            />
          </div>
        </div>
      )}

      {/* Watch / Unwatch */}
      {isWatched ? (
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" disabled>
            <BellRing size={16} className="mr-1.5" />
            Watching
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              unwatchMutation.mutate(template.templateId, {
                onSuccess: () => toast.success('Pattern unwatched'),
                onError: () => toast.error('Failed to unwatch pattern'),
              })
            }}
            disabled={unwatchMutation.isPending}
          >
            Unwatch
          </Button>
        </div>
      ) : (
        <Button
          variant="primary"
          className="w-full"
          onClick={() => {
            watchMutation.mutate(
              { templateId: template.templateId, templateText: template.templateText },
              {
                onSuccess: () =>
                  toast.success(
                    slackConfigured
                      ? "Pattern watched — you'll be notified on spikes"
                      : 'Pattern watched — configure Slack in Settings to receive notifications',
                  ),
                onError: () => toast.error('Failed to watch pattern'),
              },
            )
          }}
          disabled={watchMutation.isPending}
        >
          <Bell size={16} className="mr-1.5" />
          Watch Pattern
        </Button>
      )}
    </div>
  )
}

export function TemplateDetailPanel() {
  const { selectedTemplateId, setSelectedTemplateId } = useDashboardStore(
    useShallow((s) => ({
      selectedTemplateId: s.selectedTemplateId,
      setSelectedTemplateId: s.setSelectedTemplateId,
    })),
  )
  const { data: response } = useTemplates()
  const templates = response?.data ?? []
  const template = templates.find((t) => t.templateId === selectedTemplateId)

  // Escape key closes panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedTemplateId(null)
    }
    if (selectedTemplateId) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectedTemplateId, setSelectedTemplateId])

  if (!selectedTemplateId || !template) return null

  return (
    <>
      {/* Backdrop on mobile */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay dismisses panel */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: escape key handled separately */}
      <div
        className="fixed inset-0 bg-black/30 z-40 md:hidden"
        onClick={() => setSelectedTemplateId(null)}
      />

      {/* Panel */}
      <aside
        className={cn(
          'fixed right-0 top-0 bottom-0 z-50 w-full md:w-[480px] bg-surface-card border-l border-border',
          'overflow-y-auto shadow-2xl',
          'transform transition-transform duration-200 ease-out',
          'md:relative md:shrink-0',
        )}
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between px-5 py-4 border-b border-border-subtle bg-surface-card/95 backdrop-blur-sm">
          <h3 className="text-sm font-semibold text-text-primary truncate pr-4">Pattern Detail</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedTemplateId(null)}
            aria-label="Close pattern detail"
          >
            <X size={16} />
          </Button>
        </div>

        {/* Content */}
        <div className="p-5">
          <DetailContent template={template} />
        </div>
      </aside>
    </>
  )
}
