import { useMemo } from 'react'
import { useCostAnalysis } from '../../api/queries'
import type { CostPattern } from '../../api/types'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { QueryError } from '../../components/ui/query-error'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'

const levelColors: Record<string, string> = {
  DEBUG: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  TRACE: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  INFO: 'bg-brand-500/10 text-brand-400 border-brand-500/20',
  WARN: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  ERROR: 'bg-red-500/10 text-red-400 border-red-500/20',
}

function LevelBadge({ level }: { level: string }) {
  const style = levelColors[level.toUpperCase()] ?? 'bg-surface-elevated text-text-muted border-border-subtle'
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded-full border',
        style,
      )}
    >
      {level}
    </span>
  )
}

function PatternRow({ pattern }: { pattern: CostPattern }) {
  const isNoise = pattern.classification === 'noise'
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] border',
        isNoise
          ? 'border-red-500/20 bg-red-500/5'
          : 'border-amber-500/20 bg-amber-500/5',
      )}
    >
      <LevelBadge level={pattern.level} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-mono text-text-secondary truncate">{pattern.template}</p>
        <p className="text-[10px] text-text-muted mt-0.5">{pattern.suggestion}</p>
      </div>
      <span className="text-[10px] text-text-muted shrink-0">{pattern.service}</span>
      <span className="text-xs font-mono tabular-nums text-text-secondary shrink-0">
        {pattern.volumePct.toFixed(1)}%
      </span>
    </div>
  )
}

export function CostWidget({ className }: { className?: string }) {
  const { data: response, isLoading, isError, refetch } = useCostAnalysis()
  const analysisData = response?.data

  const { noisePatterns, reviewPatterns } = useMemo(() => {
    const patterns = analysisData?.patterns ?? []
    return {
      noisePatterns: patterns.filter((p) => p.classification === 'noise'),
      reviewPatterns: patterns.filter((p) => p.classification === 'review'),
    }
  }, [analysisData?.patterns])

  if (isLoading) {
    return (
      <Card className={cn(className)}>
        <CardHeader>
          <CardTitle>Log Cost Optimizer</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48" />
        </CardContent>
      </Card>
    )
  }

  if (isError) {
    return (
      <Card className={cn(className)}>
        <CardHeader>
          <CardTitle>Log Cost Optimizer</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryError onRetry={() => refetch()} />
        </CardContent>
      </Card>
    )
  }

  const summary = analysisData?.summary
  const hasPatterns = noisePatterns.length > 0 || reviewPatterns.length > 0

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Log Cost Optimizer</CardTitle>
          {summary && (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-400">
              {summary.totalPatternsAnalyzed} patterns analyzed
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!hasPatterns ? (
          <p className="text-xs text-text-muted py-4 text-center">
            No optimization suggestions — your logging looks efficient.
          </p>
        ) : (
          <div className="space-y-3">
            {summary && (
              <p className="text-xs text-text-secondary">
                <span className="text-danger font-medium">{summary.noiseCount} noise</span>
                {', '}
                <span className="text-amber-400 font-medium">{summary.reviewCount} review</span>
                {' patterns — '}
                <span className="text-text-primary font-medium">{summary.potentialReductionPct}%</span>
                {' potential reduction'}
              </p>
            )}

            <div className="space-y-1.5">
              {noisePatterns.map((p) => (
                <PatternRow key={p.templateId} pattern={p} />
              ))}
              {reviewPatterns.map((p) => (
                <PatternRow key={p.templateId} pattern={p} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
