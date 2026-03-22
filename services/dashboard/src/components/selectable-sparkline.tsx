/**
 * SelectableSparkline — bar chart with drag-to-select range.
 *
 * Encapsulates all ECharts brush complexity. The only output is a
 * { start, end } date range via onRangeSelect callback.
 * If we ever swap charting libraries, only this file changes.
 */

import type { EChartsOption } from 'echarts'
import { useMemo, useRef } from 'react'
import { Chart } from './chart'
import type { ChartEventHandlers } from '../hooks/use-chart'

interface SparklinePoint {
  intervalStart: string
  count: number
}

interface SelectableSparklineProps {
  points: SparklinePoint[]
  height?: number
  /** Called when user finishes dragging a selection. null = selection cleared. */
  onRangeSelect?: (range: { start: string; end: string } | null) => void
}

export function SelectableSparkline({ points, height = 140, onRangeSelect }: SelectableSparklineProps) {
  const pointsRef = useRef(points)
  pointsRef.current = points

  const option = useMemo((): EChartsOption => ({
    brush: {
      toolbox: [] as ('rect' | 'polygon' | 'lineX' | 'lineY' | 'keep' | 'clear')[],
      brushType: 'lineX' as const,
      brushMode: 'single' as const,
      xAxisIndex: 0,
      throttleType: 'debounce' as const,
      throttleDelay: 100,
      removeOnClick: true,
      brushStyle: {
        borderWidth: 1,
        color: 'rgba(79, 143, 247, 0.15)',
        borderColor: 'rgba(79, 143, 247, 0.6)',
      },
      inBrush: { opacity: 1 },
      outOfBrush: { opacity: 0.25 },
    },
    grid: { left: 40, right: 8, top: 8, bottom: 24, containLabel: false },
    xAxis: {
      type: 'category',
      data: points.map((p) => {
        const d = new Date(p.intervalStart)
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
      }),
      axisLabel: { fontSize: 10 },
    },
    yAxis: { type: 'value', splitNumber: 3, axisLabel: { fontSize: 10 } },
    series: [{
      type: 'bar',
      data: points.map((p) => p.count),
      itemStyle: { color: 'var(--color-brand-400)', borderRadius: [2, 2, 0, 0] },
    }],
    tooltip: { trigger: 'item' },
    animationDuration: 300,
  }), [points])

  const eventHandlers = useMemo((): ChartEventHandlers => ({
    brushEnd: (params: unknown) => {
      const p = params as {
        areas?: Array<{ coordRange?: [number, number] | [[number, number], [number, number]] }>
      }
      const area = p.areas?.[0]
      if (!area?.coordRange) {
        onRangeSelect?.(null)
        return
      }

      let startIdx: number
      let endIdx: number
      if (Array.isArray(area.coordRange[0])) {
        const xRange = area.coordRange[0] as [number, number]
        startIdx = xRange[0]
        endIdx = xRange[1]
      } else {
        startIdx = area.coordRange[0] as number
        endIdx = area.coordRange[1] as number
      }

      const pts = pointsRef.current
      const startPoint = pts[startIdx]
      const endPoint = pts[endIdx]
      if (startPoint && endPoint) {
        // Use the next bucket's start time as the end, or add 5 min to the last bucket
        const nextPoint = pts[endIdx + 1]
        const end = nextPoint
          ? nextPoint.intervalStart
          : endPoint.intervalStart.replace(
              /(\d{2}):(\d{2}):(\d{2})/,
              (_, h, m, s) => {
                const mins = Number(h) * 60 + Number(m) + 5
                return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:${s}`
              },
            )
        onRangeSelect?.({ start: startPoint.intervalStart, end })
      }
    },
  }), [onRangeSelect])

  return <Chart option={option} height={height} onEvents={eventHandlers} />
}
