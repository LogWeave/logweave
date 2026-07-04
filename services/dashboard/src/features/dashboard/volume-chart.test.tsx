import type { EChartsOption } from 'echarts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VolumeData } from '../../api/types'
import { renderWithProviders } from '../../test/test-utils'
import { VolumeChart } from './volume-chart'

// Capture the option handed to <Chart> so we can assert the refactored builder
// still produces a well-formed spec without booting ECharts (no canvas in jsdom).
let capturedOption: EChartsOption | null = null
vi.mock('../../components/chart', () => ({
  Chart: ({ option }: { option: EChartsOption | null }) => {
    capturedOption = option
    return <div data-testid="chart" />
  },
}))

const useVolume = vi.fn()
const useDeploys = vi.fn()
vi.mock('../../api/queries', () => ({
  useVolume: () => useVolume(),
  useDeploys: () => useDeploys(),
  pollUnlessError: () => false,
}))

const volumeData: VolumeData = {
  current: [
    { service: 'api', intervalStart: '2026-07-03T00:00:00Z', logCount: 10, errorCount: 1 },
    { service: 'web', intervalStart: '2026-07-03T00:00:00Z', logCount: 5, errorCount: 0 },
    { service: 'api', intervalStart: '2026-07-03T01:00:00Z', logCount: 20, errorCount: 2 },
  ],
}

afterEach(() => {
  capturedOption = null
  useVolume.mockReset()
  useDeploys.mockReset()
})

describe('VolumeChart (post-extraction integration)', () => {
  it('builds a chart option with one series per service and formatted axis labels', () => {
    useVolume.mockReturnValue({
      data: { data: volumeData },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    useDeploys.mockReturnValue({ data: undefined })

    renderWithProviders(<VolumeChart />)

    expect(capturedOption).not.toBeNull()
    const series = capturedOption?.series as Array<{ name: string; data: number[] }>
    expect(series.map((s) => s.name)).toEqual(['api', 'web'])
    // api summed across the two timestamps in axis order.
    expect(series[0]?.data).toEqual([10, 20])
    // web has no point in the second bucket -> padded to 0.
    expect(series[1]?.data).toEqual([5, 0])

    const xAxis = capturedOption?.xAxis as { data: string[] }
    expect(xAxis.data).toHaveLength(2)
    // Default range is 24h -> DD/MM HH:MM shape.
    for (const label of xAxis.data) {
      expect(label).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/)
    }
  })

  it('renders a loading skeleton (no chart) while volume is loading', () => {
    useVolume.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    })
    useDeploys.mockReturnValue({ data: undefined })

    const { queryByTestId } = renderWithProviders(<VolumeChart />)
    expect(queryByTestId('chart')).toBeNull()
  })
})
