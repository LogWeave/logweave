import type { EChartsOption } from 'echarts'
import { BarChart, LineChart } from 'echarts/charts'
import {
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
])

export function useChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  option: EChartsOption | null,
) {
  const chartRef = useRef<echarts.ECharts | null>(null)
  const colorMode = useDashboardStore((s) => s.colorMode)
  const theme = colorMode === 'dark' ? 'logweave-dark' : 'logweave-light'

  // Init and dispose
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const chart = echarts.init(el, theme)
    chartRef.current = chart

    // Debounce resize to prevent layout thrash cascades
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => chart.resize(), 100)
    })
    observer.observe(el)

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [containerRef, theme])

  // Update option — use replaceMerge for series to avoid accumulation
  useEffect(() => {
    if (chartRef.current && option) {
      chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true })
    }
  }, [option])

  return chartRef
}
