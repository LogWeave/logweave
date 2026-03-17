import type { EChartsOption } from 'echarts'
import { useMemo } from 'react'
import { useVolume } from '../../api/queries'
import { Chart } from '../../components/chart'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'

export function VolumeChart({ className }: { className?: string }) {
  const { data: response, isLoading } = useVolume()
  const volumeData = response?.data

  const option = useMemo((): EChartsOption | null => {
    if (!volumeData?.current?.length) return null

    // Group data by service
    const serviceMap = new Map<string, Array<{ time: string; count: number }>>()
    const timestamps = new Set<string>()

    for (const point of volumeData.current) {
      timestamps.add(point.intervalStart)
      if (!serviceMap.has(point.service)) {
        serviceMap.set(point.service, [])
      }
      serviceMap.get(point.service)?.push({
        time: point.intervalStart,
        count: point.logCount,
      })
    }

    const sortedTimestamps = [...timestamps].sort()
    const services = [...serviceMap.keys()]

    const series = services.map((service) => {
      const dataMap = new Map((serviceMap.get(service) ?? []).map((d) => [d.time, d.count]))
      return {
        name: service,
        type: 'line' as const,
        stack: 'total',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 1.5 },
        areaStyle: {
          opacity: 0.15,
        },
        data: sortedTimestamps.map((t) => dataMap.get(t) ?? 0),
      }
    })

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: {
        data: services,
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
        data: sortedTimestamps.map((t) => {
          const d = new Date(t)
          return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
        }),
        boundaryGap: false,
      },
      yAxis: {
        type: 'value',
        splitNumber: 4,
      },
      animationDuration: 600,
      animationEasing: 'cubicOut',
      series,
    }
  }, [volumeData])

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

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle>Log Volume</CardTitle>
      </CardHeader>
      <CardContent>
        <Chart option={option} height={300} />
      </CardContent>
    </Card>
  )
}
