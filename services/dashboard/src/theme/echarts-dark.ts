import * as echarts from 'echarts/core'

export const CHART_COLORS = [
  '#818cf8',
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#c084fc',
  '#fb923c',
  '#e879f9',
]

echarts.registerTheme('logweave-dark', {
  color: CHART_COLORS,
  backgroundColor: 'transparent',
  textStyle: { color: '#e8eaef', fontFamily: 'Geist, sans-serif', fontSize: 12 },
  title: { textStyle: { color: '#e8eaef', fontSize: 14, fontWeight: 600 } },
  legend: { textStyle: { color: '#9aa1b0' }, inactiveColor: '#464a52' },
  tooltip: {
    backgroundColor: 'rgba(18, 24, 40, 0.95)',
    borderColor: '#2d3548',
    borderWidth: 1,
    textStyle: { color: '#e8eaef', fontSize: 13 },
    extraCssText: 'border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);',
  },
  categoryAxis: {
    axisLine: { lineStyle: { color: '#2d3548' } },
    axisTick: { show: false },
    axisLabel: { color: '#686e7a', fontSize: 11 },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#686e7a', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1a2236', type: 'dashed' } },
  },
})
