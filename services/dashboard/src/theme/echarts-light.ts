import * as echarts from 'echarts/core'
import { CHART_COLORS } from './echarts-dark'

echarts.registerTheme('logweave-light', {
  color: CHART_COLORS,
  backgroundColor: 'transparent',
  textStyle: { color: '#1a1a2e', fontFamily: 'Geist, sans-serif', fontSize: 12 },
  title: { textStyle: { color: '#1a1a2e', fontSize: 14, fontWeight: 600 } },
  legend: { textStyle: { color: '#4a5568' }, inactiveColor: '#a0aec0' },
  tooltip: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    textStyle: { color: '#1a1a2e', fontSize: 13 },
    extraCssText: 'border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.1);',
  },
  categoryAxis: {
    axisLine: { lineStyle: { color: '#e2e8f0' } },
    axisTick: { show: false },
    axisLabel: { color: '#718096', fontSize: 11 },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#718096', fontSize: 11 },
    splitLine: { lineStyle: { color: '#f1f3f5', type: 'dashed' } },
  },
})
