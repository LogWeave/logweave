import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { config } from '../config'
import { api } from '../lib/api-client'
import { timeRangeToHours, useDashboardStore } from '../stores/dashboard-store'
import type {
  ApiResponse,
  ChangeEvent,
  ClusteringHealthData,
  OverviewData,
  ServiceRow,
  SparklineData,
  TemplateRow,
  VolumeData,
} from './types'

/**
 * Pause polling when the query is in error state to prevent hammering a down API.
 * Adds a small jitter (0-5s) so all 7 queries don't refetch in the same frame.
 */
export function pollUnlessError(query: { state: { status: string } }): number | false {
  if (query.state.status === 'error') return false
  return config.pollIntervalMs + Math.floor(Math.random() * 5000)
}

export function useOverview() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'overview', hours],
    queryFn: () => api.get<ApiResponse<OverviewData>>('/v1/dashboard/overview', { hours }),
    refetchInterval: pollUnlessError,
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
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useServices() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'services', hours],
    queryFn: () => api.get<ApiResponse<ServiceRow[]>>('/v1/dashboard/services', { hours }),
    refetchInterval: pollUnlessError,
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
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useSparklines(templateIds: string[]) {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  // Stabilize the key — array reference changes on every render but content may be the same
  const idsKey = templateIds.join(',')
  return useQuery({
    queryKey: ['dashboard', 'sparklines', hours, idsKey],
    queryFn: () =>
      api.get<ApiResponse<SparklineData>>('/v1/dashboard/template-sparklines', {
        hours,
        template_ids: idsKey,
      }),
    enabled: templateIds.length > 0,
    refetchInterval: pollUnlessError,
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
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useChanges() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'changes', hours, serviceFilter],
    queryFn: () =>
      api.get<ApiResponse<ChangeEvent[]>>('/v1/dashboard/changes', {
        hours,
        service: serviceFilter ?? undefined,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}
