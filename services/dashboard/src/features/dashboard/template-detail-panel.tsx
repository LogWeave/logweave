import { Bell, BellRing, Radio, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import {
  useCreateRule,
  useSlackSettings,
  useSparklines,
  useTemplateEvents,
  useTemplateStatusCodes,
  useTemplates,
  useUnwatchTemplate,
  useWatches,
  useWatchTemplate,
} from '../../api/queries'
import type { TemplateRow } from '../../api/types'
import { SelectableSparkline } from '../../components/selectable-sparkline'
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

function InvestigationPrompt({
  statusCode,
  templateId,
  service,
  timeRange,
  onClose,
}: {
  statusCode: number
  templateId: string
  service: string
  timeRange?: { start: string; end: string } | null
  onClose: () => void
}) {
  const timeContext = timeRange
    ? ` Focus on the window between ${new Date(timeRange.start).toLocaleTimeString()} and ${new Date(timeRange.end).toLocaleTimeString()}.`
    : ''
  const prompt = `Show me the ${statusCode} errors for template ${templateId} on ${service}.${timeContext} What's causing them? Check the trace IDs and related patterns.`

  return (
    <div className="bg-surface-base rounded-[var(--radius-md)] p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
          Investigate {statusCode}s
        </h4>
        <button
          type="button"
          className="text-[10px] text-text-muted hover:text-text-primary"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">
        Ask your AI assistant to investigate these errors:
      </p>
      <div className="bg-surface-card rounded-[var(--radius-sm)] p-2.5 text-xs font-mono text-text-primary leading-relaxed">
        {prompt}
      </div>
      <Button
        variant="secondary"
        className="w-full text-xs"
        onClick={() => {
          navigator.clipboard.writeText(prompt)
          toast.success('Copied to clipboard')
        }}
      >
        Copy prompt
      </Button>
    </div>
  )
}

function DetailContent({ template }: { template: TemplateRow }) {
  const selectedTimeRange = useDashboardStore((s) => s.selectedTimeRange)
  const setSelectedTimeRange = useDashboardStore((s) => s.setSelectedTimeRange)
  const investigatingStatusCode = useDashboardStore((s) => s.investigatingStatusCode)
  const setInvestigatingStatusCode = useDashboardStore((s) => s.setInvestigatingStatusCode)

  const globalTimeRange = useDashboardStore((s) => s.timeRange)
  const { data: sparklineResponse } = useSparklines([template.templateId])
  const allSparklinePoints = sparklineResponse?.data?.[template.templateId] ?? []
  // Cap sparkline to 24h max (288 x 5-min buckets) — beyond that it's unreadable
  const MAX_SPARKLINE_POINTS = 288
  const sparklinePoints =
    allSparklinePoints.length > MAX_SPARKLINE_POINTS
      ? allSparklinePoints.slice(-MAX_SPARKLINE_POINTS)
      : allSparklinePoints
  const sparklineHours = Math.min({ '1h': 1, '6h': 6, '24h': 24, '7d': 168 }[globalTimeRange], 24)
  const statusCodeTimeWindow = selectedTimeRange
    ? { since: selectedTimeRange.start, until: selectedTimeRange.end }
    : null
  const { data: statusCodeResponse } = useTemplateStatusCodes(
    template.templateId,
    statusCodeTimeWindow,
  )
  const statusCodes = statusCodeResponse?.data ?? []
  const navigate = useNavigate()
  const { data: watchesResponse } = useWatches()
  const watchedIds = watchesResponse?.data ?? []
  const isWatched = watchedIds.some((w) => w.templateId === template.templateId)
  const watchMutation = useWatchTemplate()
  const unwatchMutation = useUnwatchTemplate()
  const createRuleMutation = useCreateRule()
  const { data: eventsResponse } = useTemplateEvents(
    template.templateId,
    investigatingStatusCode ?? undefined,
  )
  const templateEvents = eventsResponse?.data ?? []
  const { data: slackResponse } = useSlackSettings()
  const slackConfigured = slackResponse?.data?.configured ?? false

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

      {/* Stats grid — shows selected range stats when brush is active */}
      {selectedTimeRange && (
        <div className="text-[10px] text-brand-400 flex items-center gap-2">
          <span>
            Selected:{' '}
            {new Date(selectedTimeRange.start).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {' – '}
            {new Date(selectedTimeRange.end).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <button
            type="button"
            className="hover:text-brand-300 underline"
            onClick={() => setSelectedTimeRange(null)}
          >
            Clear
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <StatBox
          label="Occurrences"
          value={template.occurrenceCount.toLocaleString()}
          secondary={
            selectedTimeRange
              ? (() => {
                  const selected = sparklinePoints
                    .filter(
                      (p) =>
                        p.intervalStart >= selectedTimeRange.start &&
                        p.intervalStart < selectedTimeRange.end,
                    )
                    .reduce((sum, p) => sum + p.count, 0)
                  return `${selected.toLocaleString()} selected`
                })()
              : undefined
          }
        />
        <StatBox
          label="Errors"
          value={template.errorCount.toLocaleString()}
          valueClassName={template.errorCount > 0 ? 'text-danger' : undefined}
          secondary={
            selectedTimeRange
              ? (() => {
                  const totalStatusCodes = statusCodes.reduce((sum, sc) => sum + sc.count, 0)
                  const errorCodes = statusCodes.filter((sc) => sc.statusCode >= 500)
                  const errorCount = errorCodes.reduce((sum, sc) => sum + sc.count, 0)
                  return `${errorCount.toLocaleString()} in selection (${totalStatusCodes > 0 ? ((errorCount / totalStatusCodes) * 100).toFixed(1) : 0}%)`
                })()
              : undefined
          }
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
                  onClick={() =>
                    setInvestigatingStatusCode(
                      investigatingStatusCode === sc.statusCode ? null : sc.statusCode,
                    )
                  }
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

      {/* Investigation prompt — shown when a status code is clicked */}
      {investigatingStatusCode != null && (
        <InvestigationPrompt
          statusCode={investigatingStatusCode}
          templateId={template.templateId}
          service={template.service}
          timeRange={selectedTimeRange}
          onClose={() => setInvestigatingStatusCode(null)}
        />
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
            Occurrence History ({sparklineHours}h)
            <InfoTooltip content={TOOLTIPS.occurrenceHistory} />
          </h4>
          <div className="bg-surface-base rounded-[var(--radius-md)] p-2">
            <SelectableSparkline
              points={sparklinePoints}
              height={140}
              onRangeSelect={setSelectedTimeRange}
            />
          </div>
          <p className="text-[9px] text-text-muted mt-1 text-center">Drag to select a time range</p>
        </div>
      )}

      {/* Recent events with trace IDs */}
      {templateEvents.length > 0 && (
        <div>
          <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
            Recent Events ({templateEvents.length})
          </h4>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {templateEvents.map((evt, i) => (
              <div
                key={`${evt.timestamp}-${i}`}
                className="flex items-center gap-2 text-[10px] py-1 px-2 rounded bg-surface-base"
              >
                <span className="font-mono text-text-muted shrink-0">
                  {new Date(evt.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <span
                  className={cn(
                    'shrink-0',
                    evt.level === 'ERROR' ? 'text-danger' : 'text-text-muted',
                  )}
                >
                  {evt.statusCode || evt.level}
                </span>
                <span className="text-text-secondary truncate">{evt.route || evt.service}</span>
                {evt.traceId && (
                  <button
                    type="button"
                    className="ml-auto shrink-0 font-mono text-brand-400 hover:underline"
                    title="Copy trace ID"
                    onClick={() => {
                      navigator.clipboard.writeText(evt.traceId)
                      toast.success('Trace ID copied')
                    }}
                  >
                    {evt.traceId.slice(0, 8)}...
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <Button
        variant="secondary"
        className="w-full text-xs"
        onClick={() =>
          navigate(`/tail?templateId=${template.templateId}&service=${template.service}`)
        }
      >
        <Radio size={14} className="mr-1.5" />
        Tail this pattern
      </Button>

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
            createRuleMutation.mutate(
              {
                name: `Watch: ${template.templateText.slice(0, 80)}`,
                ruleType: 'template_watch',
                config: {
                  templateId: template.templateId,
                  templateText: template.templateText,
                },
              },
              {
                onError: () => toast.error('Failed to create alert rule for watched pattern'),
              },
            )
          }}
          disabled={watchMutation.isPending || createRuleMutation.isPending}
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

  return (
    <AnimatePresence>
      {selectedTemplateId && template && (
        <>
          {/* Backdrop on mobile */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay dismisses panel */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: escape key handled separately */}
          <motion.div
            className="fixed inset-0 bg-black/30 z-40 md:hidden"
            onClick={() => setSelectedTemplateId(null)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Panel */}
          <motion.aside
            className={cn(
              'fixed right-0 top-0 bottom-0 z-50 w-full md:w-[380px] lg:w-[440px] xl:w-[480px] bg-surface-card border-l border-border',
              'overflow-y-auto shadow-2xl',
              'md:relative md:shrink-0',
            )}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          >
            {/* Header */}
            <div className="sticky top-0 flex items-center justify-between px-5 py-4 border-b border-border-subtle bg-surface-card/95 backdrop-blur-sm">
              <h3 className="text-sm font-semibold text-text-primary truncate pr-4">
                Pattern Detail
              </h3>
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
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
