import { useQuery } from '@tanstack/react-query'
import { config } from '../config'
import { api } from '../lib/api-client'
import { timeRangeToHours, useDashboardStore } from '../stores/dashboard-store'
import type {
  ApiResponse,
  ClusteringHealthData,
  OverviewData,
  ServiceRow,
  SparklineData,
  TemplateRow,
  VolumeData,
} from './types'

export function useOverview() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'overview', hours],
    queryFn: () => api.get<ApiResponse<OverviewData>>('/v1/dashboard/overview', { hours }),
    refetchInterval: config.pollIntervalMs,
    staleTime: config.staleTimeMs,
  })
}

export function useVolume() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'volume', hours, serviceFilter],
    queryFn: () =>
      api.get<ApiResponse<VolumeData>>('/v1/dashboard/volume', {
        hours,
        service: serviceFilter ?? undefined,
      }),
    refetchInterval: config.pollIntervalMs,
    staleTime: config.staleTimeMs,
  })
}

export function useServices() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'services', hours],
    queryFn: () => api.get<ApiResponse<ServiceRow[]>>('/v1/dashboard/services', { hours }),
    refetchInterval: config.pollIntervalMs,
    staleTime: config.staleTimeMs,
  })
}

export function useTemplates() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'templates', hours, serviceFilter],
    queryFn: () =>
      api.get<ApiResponse<TemplateRow[]>>('/v1/dashboard/templates', {
        hours,
        limit: 200,
        service: serviceFilter ?? undefined,
      }),
    refetchInterval: config.pollIntervalMs,
    staleTime: config.staleTimeMs,
  })
}

export function useSparklines(templateIds: string[]) {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'sparklines', hours, templateIds],
    queryFn: () =>
      api.get<ApiResponse<SparklineData>>('/v1/dashboard/template-sparklines', {
        hours,
        template_ids: templateIds.join(','),
      }),
    enabled: templateIds.length > 0,
    refetchInterval: config.pollIntervalMs,
    staleTime: config.staleTimeMs,
  })
}

export function useClusteringHealth() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'clustering-health', hours],
    queryFn: () =>
      api.get<ApiResponse<ClusteringHealthData>>('/v1/dashboard/clustering-health', { hours }),
    refetchInterval: config.pollIntervalMs,
    staleTime: config.staleTimeMs,
  })
}
