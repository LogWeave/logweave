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

    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(el)

    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [containerRef, theme])

  // Update option
  useEffect(() => {
    if (chartRef.current && option) {
      chartRef.current.setOption(option, { notMerge: true })
    }
  }, [option])

  return chartRef
}
