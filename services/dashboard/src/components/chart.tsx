import type { EChartsOption } from 'echarts'
import { useRef } from 'react'
import { type ChartEventHandlers, useChart } from '../hooks/use-chart'
import { cn } from '../lib/cn'

interface ChartProps {
  option: EChartsOption | null
  height?: number | string
  loading?: boolean
  className?: string
  onEvents?: ChartEventHandlers
}

export function Chart({ option, height = 300, loading, className, onEvents }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  useChart(containerRef, option, onEvents)

  return (
    <div className={cn('relative', className)}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-card/50 rounded-lg z-10">
          <div className="h-5 w-5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      <div ref={containerRef} style={{ height }} />
    </div>
  )
}
