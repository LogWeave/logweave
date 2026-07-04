import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { EChartsOption } from 'echarts'
import { useMemo, useState } from 'react'
import { pollUnlessError, useDeploys, useVolume } from '../../api/queries'
import type { ApiResponse, VolumeData } from '../../api/types'
import { Chart } from '../../components/chart'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { QueryError } from '../../components/ui/query-error'
import { Skeleton } from '../../components/ui/skeleton'
import { ToggleGroup } from '../../components/ui/toggle'
import { config } from '../../config'
import { api } from '../../lib/api-client'
import { cn } from '../../lib/cn'
import { timeRangeToHours, useDashboardStore } from '../../stores/dashboard-store'
import {
  buildServiceMap,
  findClosestTimestampIndex,
  formatVolumeAxisLabel,
  sumCountsByTimestamp,
} from './volume-chart-data'

type ChartType = 'area' | 'bar' | 'line'

const chartTypeOptions = [
  { value: 'area', label: 'Area' },
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
]

export function VolumeChart({ className }: { className?: string }) {
  const [chartType, setChartType] = useState<ChartType>('area')
  const [compareEnabled, setCompareEnabled] = useState(false)
  const { data: response, isLoading, isError, refetch } = useVolume()
  const volumeData = response?.data
  const { data: deploysResponse } = useDeploys()

  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  const levelParam = levelFilters.length > 0 ? levelFilters.join(',') : undefined

  const { data: compareResponse } = useQuery({
    queryKey: ['dashboard', 'volume-compare', hours, serviceFilter, levelParam],
    queryFn: () =>
      api.get<ApiResponse<VolumeData>>('/v1/dashboard/volume', {
        hours,
        offset: hours,
        service: serviceFilter ?? undefined,
        level: levelParam,
      }),
    enabled: compareEnabled,
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })

  const compareData = compareEnabled ? compareResponse?.data : undefined

  const isLevelFiltered = levelFilters.length > 0

  const { data: unfilteredResponse } = useQuery({
    queryKey: ['dashboard', 'volume-total', hours, serviceFilter],
    queryFn: () =>
      api.get<ApiResponse<VolumeData>>('/v1/dashboard/volume', {
        hours,
        service: serviceFilter ?? undefined,
      }),
    enabled: isLevelFiltered,
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })

  const option = useMemo((): EChartsOption | null => {
    if (!volumeData?.current?.length) return null

    const { serviceMap, timestamps } = buildServiceMap(volumeData.current)
    const sortedTimestamps = [...timestamps].sort()
    const services = [...serviceMap.keys()]

    // Current period series — config varies by chart type
    const seriesConfig =
      chartType === 'bar'
        ? { type: 'bar' as const, stack: 'total', barMaxWidth: 20 }
        : chartType === 'line'
          ? {
              type: 'line' as const,
              smooth: true,
              symbol: 'circle' as const,
              symbolSize: 4,
              lineStyle: { width: 1.5 },
            }
          : {
              type: 'line' as const,
              stack: 'total',
              smooth: true,
              symbol: 'none' as const,
              lineStyle: { width: 1.5 },
              areaStyle: { opacity: 0.15 },
            }

    const currentSeries = services.map((service) => {
      const dataMap = new Map((serviceMap.get(service) ?? []).map((d) => [d.time, d.count]))
      return {
        name: service,
        ...seriesConfig,
        data: sortedTimestamps.map((t) => dataMap.get(t) ?? 0),
      }
    })

    // Compare period series (dashed, lower opacity)
    const compareSeries: typeof currentSeries = []
    if (compareData?.current?.length) {
      const { serviceMap: prevServiceMap, timestamps: prevTimestamps } = buildServiceMap(
        compareData.current,
      )
      const sortedPrevTimestamps = [...prevTimestamps].sort()

      // Map previous timestamps to current timestamp positions for overlay
      for (const service of services) {
        const prevPoints = prevServiceMap.get(service) ?? []
        const prevDataMap = new Map(prevPoints.map((d) => [d.time, d.count]))
        // Use the previous sorted timestamps but align to same x-axis positions
        const data = sortedPrevTimestamps.map((t) => prevDataMap.get(t) ?? 0)
        // Pad or trim to match current length
        const alignedData = sortedTimestamps.map((_, i) => data[i] ?? 0)

        compareSeries.push({
          name: `prev ${service}`,
          type: 'line' as const,
          stack: 'prev-total',
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 1, type: 'dashed' } as never,
          areaStyle: {
            opacity: 0.05,
          },
          data: alignedData,
        })
      }
    }

    const ghostSeries: typeof currentSeries = []
    if (isLevelFiltered && unfilteredResponse?.data?.current?.length) {
      // Build a single "Total" ghost line by summing all services.
      const totalByTimestamp = sumCountsByTimestamp(unfilteredResponse.data.current)
      ghostSeries.push({
        name: 'Total (unfiltered)',
        type: 'line' as const,
        stack: 'ghost',
        smooth: true,
        symbol: 'none' as const,
        lineStyle: { width: 1, type: 'dashed' } as never,
        areaStyle: { opacity: 0 },
        data: sortedTimestamps.map((t) => totalByTimestamp.get(t) ?? 0),
      })
    }

    // Deploy markers — vertical lines at deploy timestamps
    const deploys = deploysResponse?.data ?? []
    if (deploys.length > 0 && currentSeries.length > 0) {
      const deployMarks = deploys.map((d) => {
        // Anchor the deploy marker to the nearest x-axis category.
        const closestIdx = findClosestTimestampIndex(
          sortedTimestamps,
          new Date(d.timestamp).getTime(),
        )
        return {
          xAxis: closestIdx,
          label: { formatter: d.version ?? d.service, fontSize: 9, color: '#818cf8' },
          lineStyle: { color: '#818cf8', type: 'dashed' as const, width: 1 },
        }
      })
      const first = currentSeries[0]
      if (first) {
        currentSeries[0] = {
          ...first,
          markLine: {
            silent: true,
            symbol: ['none', 'none'],
            data: deployMarks,
          },
        } as unknown as typeof first
      }
    }

    const allSeries = [...currentSeries, ...compareSeries, ...ghostSeries]
    const legendData = [
      ...services,
      ...(compareSeries.length > 0 ? compareSeries.map((s) => s.name) : []),
      ...(ghostSeries.length > 0 ? ghostSeries.map((s) => s.name) : []),
    ]

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: {
        data: legendData,
        bottom: 0,
        left: 'center',
        type: 'scroll',
      },
      grid: {
        left: 48,
        right: 16,
        top: 16,
        bottom: 40,
        containLabel: false,
      },
      xAxis: {
        type: 'category',
        data: sortedTimestamps.map((t) => formatVolumeAxisLabel(t, timeRange)),
        boundaryGap: chartType === 'bar',
      },
      yAxis: {
        type: 'value',
        splitNumber: 4,
      },
      animationDuration: 600,
      animationEasing: 'cubicOut',
      series: allSeries,
    }
  }, [
    volumeData,
    compareData,
    chartType,
    unfilteredResponse,
    isLevelFiltered,
    timeRange,
    deploysResponse,
  ])

  if (isLoading) {
    return (
      <Card className={cn(className)}>
        <CardHeader>
          <CardTitle>Log Volume</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    )
  }

  if (isError) {
    return (
      <Card className={cn(className)}>
        <CardHeader>
          <CardTitle>Log Volume</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryError onRetry={() => refetch()} />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Log Volume</CardTitle>
          <div className="flex items-center gap-2">
            <ToggleGroup
              options={chartTypeOptions}
              value={chartType}
              onChange={(v) => setChartType(v as ChartType)}
            />
            <Button
              variant={compareEnabled ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setCompareEnabled((prev) => !prev)}
            >
              Compare
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Chart option={option} height={300} />
      </CardContent>
    </Card>
  )
}
