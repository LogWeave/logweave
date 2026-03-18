import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useShallow } from 'zustand/shallow'
import { useSparklines, useTemplates } from '../../api/queries'
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
          value={template.maxAnomalyScore.toFixed(2)}
          valueClassName={
            template.maxAnomalyScore > 1
              ? 'text-danger'
              : template.maxAnomalyScore > 0.5
                ? 'text-warning'
                : undefined
          }
        />
      </div>

      {/* Metadata */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted">Service</span>
          <span className="text-text-primary">{template.service}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted">Pattern ID</span>
          <span className="font-mono text-text-primary">{template.templateId.slice(0, 16)}...</span>
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
                    data: sparklinePoints.map((p) => p.count),
                    itemStyle: { color: 'var(--color-brand-400)', borderRadius: [2, 2, 0, 0] },
                  },
                ],
                tooltip: { trigger: 'axis' },
                animationDuration: 300,
              }}
              height={140}
            />
          </div>
        </div>
      )}

      {/* Alert stub */}
      <Button variant="primary" className="w-full" disabled>
        Create Alert (coming soon)
      </Button>
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
