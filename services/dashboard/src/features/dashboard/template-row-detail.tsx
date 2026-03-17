import type { TemplateRow } from '../../api/types'
import { cn } from '../../lib/cn'

interface TemplateRowDetailProps {
  template: TemplateRow
}

export function TemplateRowDetail({ template }: TemplateRowDetailProps) {
  return (
    <div className="px-4 py-3 bg-surface-elevated/50 border-t border-border-subtle">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
        <div>
          <span className="text-text-muted block mb-0.5">Template ID</span>
          <span className="text-text-primary font-mono">{template.templateId.slice(0, 12)}...</span>
        </div>
        <div>
          <span className="text-text-muted block mb-0.5">Avg Duration</span>
          <span className="text-text-primary font-mono tabular-nums">
            {template.avgDurationMs.toFixed(1)}ms
          </span>
        </div>
        <div>
          <span className="text-text-muted block mb-0.5">Anomaly Score</span>
          <span
            className={cn(
              'font-mono tabular-nums',
              template.maxAnomalyScore > 1 ? 'text-danger' : 'text-text-primary',
            )}
          >
            {template.maxAnomalyScore.toFixed(2)}
          </span>
        </div>
        <div>
          <span className="text-text-muted block mb-0.5">Error Count</span>
          <span
            className={cn(
              'font-mono tabular-nums',
              template.errorCount > 0 ? 'text-danger' : 'text-text-primary',
            )}
          >
            {template.errorCount.toLocaleString()}
          </span>
        </div>
      </div>
      <div className="mt-3">
        <span className="text-text-muted text-xs block mb-1">Full Template</span>
        <code className="text-xs font-mono text-text-primary bg-surface-base p-2 rounded-[var(--radius-md)] block whitespace-pre-wrap break-all">
          {template.templateText}
        </code>
      </div>
    </div>
  )
}
