import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { config } from '../config'
import { api } from '../lib/api-client'
import { timeRangeToHours, useDashboardStore } from '../stores/dashboard-store'
import type {
  ApiResponse,
  ChangeEvent,
  ClusteringHealthData,
  LevelCount,
  OverviewData,
  ServiceRow,
  SlackSettings,
  SlackTestResult,
  SparklineData,
  StatusCodeCount,
  TemplateRow,
  VolumeData,
  WatchEntry,
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
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'overview', hours, levelFilters.join(',')],
    queryFn: () =>
      api.get<ApiResponse<OverviewData>>('/v1/dashboard/overview', {
        hours,
        level: levelFilters.length > 0 ? levelFilters.join(',') : undefined,
      }),
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useVolume() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'volume', hours, serviceFilter, levelFilters.join(',')],
    queryFn: () =>
      api.get<ApiResponse<VolumeData>>('/v1/dashboard/volume', {
        hours,
        service: serviceFilter ?? undefined,
        level: levelFilters.length > 0 ? levelFilters.join(',') : undefined,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useServices() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'services', hours, levelFilters.join(',')],
    queryFn: () =>
      api.get<ApiResponse<ServiceRow[]>>('/v1/dashboard/services', {
        hours,
        level: levelFilters.length > 0 ? levelFilters.join(',') : undefined,
      }),
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useTemplates() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'templates', hours, serviceFilter, levelFilters.join(',')],
    queryFn: () =>
      api.get<ApiResponse<TemplateRow[]>>('/v1/dashboard/templates', {
        hours,
        limit: 200,
        service: serviceFilter ?? undefined,
        level: levelFilters.length > 0 ? levelFilters.join(',') : undefined,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useSparklines(templateIds: string[]) {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  // Stabilize the key — array reference changes on every render but content may be the same
  const idsKey = templateIds.join(',')
  return useQuery({
    queryKey: ['dashboard', 'sparklines', hours, idsKey, levelFilters.join(',')],
    queryFn: () =>
      api.get<ApiResponse<SparklineData>>('/v1/dashboard/template-sparklines', {
        hours,
        template_ids: idsKey,
        level: levelFilters.length > 0 ? levelFilters.join(',') : undefined,
      }),
    enabled: templateIds.length > 0,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useClusteringHealth() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'clustering-health', hours, levelFilters.join(',')],
    queryFn: () =>
      api.get<ApiResponse<ClusteringHealthData>>('/v1/dashboard/clustering-health', {
        hours,
        level: levelFilters.length > 0 ? levelFilters.join(',') : undefined,
      }),
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useChanges() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'changes', hours, serviceFilter, levelFilters.join(',')],
    queryFn: () =>
      api.get<ApiResponse<ChangeEvent[]>>('/v1/dashboard/changes', {
        hours,
        service: serviceFilter ?? undefined,
        level: levelFilters.length > 0 ? levelFilters.join(',') : undefined,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useLevels() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'levels', hours, serviceFilter],
    queryFn: () =>
      api.get<ApiResponse<LevelCount[]>>('/v1/dashboard/levels', {
        hours,
        service: serviceFilter ?? undefined,
      }),
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useTemplateStatusCodes(templateId: string | null) {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: ['dashboard', 'template-status-codes', hours, templateId],
    queryFn: () =>
      api.get<ApiResponse<StatusCodeCount[]>>('/v1/dashboard/template-status-codes', {
        hours,
        template_id: templateId ?? undefined,
      }),
    enabled: templateId !== null,
    staleTime: config.staleTimeMs,
  })
}

export function useWatches() {
  return useQuery({
    queryKey: ['watches'],
    queryFn: () => api.get<ApiResponse<WatchEntry[]>>('/v1/watches'),
    staleTime: config.staleTimeMs,
  })
}

export function useWatchTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ templateId, templateText }: { templateId: string; templateText?: string }) =>
      api.post('/v1/watches', { templateId, templateText }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watches'] })
    },
  })
}

export function useUnwatchTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (templateId: string) => api.del(`/v1/watches/${templateId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watches'] })
    },
  })
}

export function useSlackSettings() {
  return useQuery({
    queryKey: ['settings', 'slack'],
    queryFn: () => api.get<ApiResponse<SlackSettings>>('/v1/settings/slack'),
    staleTime: 30_000,
  })
}

export function useSaveSlackSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (webhookUrl: string) => api.post('/v1/settings/slack', { webhookUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'slack'] })
    },
  })
}

export function useDeleteSlackSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.del('/v1/settings/slack'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'slack'] })
    },
  })
}

export function useTestSlackConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<ApiResponse<SlackTestResult>>('/v1/settings/slack/test'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'slack'] })
    },
  })
}
