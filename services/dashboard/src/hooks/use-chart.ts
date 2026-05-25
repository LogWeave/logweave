import type { EChartsOption } from 'echarts'
import { BarChart, LineChart } from 'echarts/charts'
import {
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  ToolboxComponent,
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
  ToolboxComponent,
])

export type ChartEventHandlers = Record<string, (params: unknown) => void>

export function useChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  option: EChartsOption | null,
  eventHandlers?: ChartEventHandlers,
) {
  const chartRef = useRef<echarts.ECharts | null>(null)
  const handlersRef = useRef(eventHandlers)
  handlersRef.current = eventHandlers
  const brushActivated = useRef(false)
  const colorMode = useDashboardStore((s) => s.colorMode)
  const theme = colorMode === 'dark' ? 'logweave-dark' : 'logweave-light'

  // Init, dispose, and wire events — all in one effect to avoid race conditions.
  // containerRef.current is read at mount; refs are intentionally exempt from
  // the deps list (mutating them doesn't re-render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are exempt
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const existing = echarts.getInstanceByDom(el)
    if (existing) existing.dispose()

    const chart = echarts.init(el, theme)
    chartRef.current = chart
    brushActivated.current = false
    let disposed = false

    // Wire event handlers via ref (stable wrappers that delegate to latest handlers)
    const wrappers: Array<[string, (p: unknown) => void]> = []
    if (handlersRef.current) {
      for (const [event, _handler] of Object.entries(handlersRef.current)) {
        const wrapper = (p: unknown) => handlersRef.current?.[event]?.(p)
        wrappers.push([event, wrapper])
        chart.on(event, wrapper)
      }
    }

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
      for (const [event, wrapper] of wrappers) {
        chart.off(event, wrapper)
      }
      chart.dispose()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // Update option + re-wire event handlers (chart definitely exists after setOption)
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !option) return
    chart.setOption(option, { notMerge: true, lazyUpdate: true })

    // Re-wire handlers on every option update (handlers may reference new data)
    const currentHandlers = handlersRef.current
    if (currentHandlers) {
      for (const [evt, fn] of Object.entries(currentHandlers)) {
        chart.off(evt)
        chart.on(evt, fn)
      }
    }

    // Activate brush cursor once if option includes brush config
    const optionObj = option as Record<string, unknown>
    if (optionObj.brush && !brushActivated.current) {
      brushActivated.current = true
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType: 'lineX', brushMode: 'single' },
      })
    }
  }, [option])

  return chartRef
}
