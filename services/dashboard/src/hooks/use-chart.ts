import type { EChartsOption } from 'echarts'
import { BarChart, LineChart } from 'echarts/charts'
import {
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'
import { useDashboardStore } from '../stores/dashboard-store'

// Register once at module level
echarts.use([
  CanvasRenderer,
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  BrushComponent,
])

export type ChartEventHandlers = Record<string, (params: unknown) => void>

export function useChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  option: EChartsOption | null,
  eventHandlers?: ChartEventHandlers,
) {
  const chartRef = useRef<echarts.ECharts | null>(null)
  const colorMode = useDashboardStore((s) => s.colorMode)
  const theme = colorMode === 'dark' ? 'logweave-dark' : 'logweave-light'

  // Init and dispose — theme changes require full re-init
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // Dispose any existing instance on this DOM element to prevent orphans
    const existing = echarts.getInstanceByDom(el)
    if (existing) existing.dispose()

    const chart = echarts.init(el, theme)
    chartRef.current = chart
    let disposed = false

    // Debounce resize to prevent layout thrash cascades
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!disposed) chart.resize()
      }, 100)
    })
    observer.observe(el)

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // Update option — use notMerge to avoid series accumulation
  useEffect(() => {
    if (chartRef.current && option) {
      chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true })
    }
  }, [option])

  // Wire event handlers
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !eventHandlers) return

    for (const [event, handler] of Object.entries(eventHandlers)) {
      chart.on(event, handler)
    }

    return () => {
      for (const [event, handler] of Object.entries(eventHandlers)) {
        chart.off(event, handler)
      }
    }
  }, [eventHandlers])

  return chartRef
}
