import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { config } from '../config'
import { api } from '../lib/api-client'
import { timeRangeToHours, useDashboardStore } from '../stores/dashboard-store'
import { levelApiParam, levelParam, queryKeys } from './query-keys'
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
 * Adds 0-15s jitter so 10+ queries spread across the poll window instead of
 * firing simultaneously and causing re-render storms.
 */
export function pollUnlessError(query: { state: { status: string } }): number | false {
  if (query.state.status === 'error') return false
  return config.pollIntervalMs + Math.floor(Math.random() * 15_000)
}

export function useOverview() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  const levels = levelParam(levelFilters)
  return useQuery({
    queryKey: queryKeys.overview(hours, levels),
    queryFn: () =>
      api.get<ApiResponse<OverviewData>>('/v1/dashboard/overview', {
        hours,
        compare: 'true',
        level: levelApiParam(levelFilters),
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
  const levels = levelParam(levelFilters)
  return useQuery({
    queryKey: queryKeys.volume(hours, serviceFilter, levels),
    queryFn: () =>
      api.get<ApiResponse<VolumeData>>('/v1/dashboard/volume', {
        hours,
        service: serviceFilter ?? undefined,
        level: levelApiParam(levelFilters),
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
  const levels = levelParam(levelFilters)
  return useQuery({
    queryKey: queryKeys.services(hours, levels),
    queryFn: () =>
      api.get<ApiResponse<ServiceRow[]>>('/v1/dashboard/services', {
        hours,
        level: levelApiParam(levelFilters),
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
  const levels = levelParam(levelFilters)
  return useQuery({
    queryKey: queryKeys.templates(hours, serviceFilter, levels),
    queryFn: () =>
      api.get<ApiResponse<TemplateRow[]>>('/v1/dashboard/templates', {
        hours,
        limit: 200,
        service: serviceFilter ?? undefined,
        level: levelApiParam(levelFilters),
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
  const idsKey = templateIds.join(',')
  const levels = levelParam(levelFilters)
  return useQuery({
    queryKey: queryKeys.sparklines(hours, idsKey, levels),
    queryFn: () =>
      api.get<ApiResponse<SparklineData>>('/v1/dashboard/template-sparklines', {
        hours,
        template_ids: idsKey,
        level: levelApiParam(levelFilters),
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
  const levels = levelParam(levelFilters)
  return useQuery({
    queryKey: queryKeys.clusteringHealth(hours, levels),
    queryFn: () =>
      api.get<ApiResponse<ClusteringHealthData>>('/v1/dashboard/clustering-health', {
        hours,
        level: levelApiParam(levelFilters),
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
  const levels = levelParam(levelFilters)
  return useQuery({
    queryKey: queryKeys.changes(hours, serviceFilter, levels),
    queryFn: () =>
      api.get<ApiResponse<import('./types').ChangesData>>('/v1/dashboard/changes', {
        hours,
        service: serviceFilter ?? undefined,
        level: levelApiParam(levelFilters),
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
    queryKey: queryKeys.levels(hours, serviceFilter),
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
    queryKey: queryKeys.templateStatusCodes(hours, templateId),
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
    queryKey: queryKeys.watches(),
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
      queryClient.invalidateQueries({ queryKey: queryKeys.watches() })
    },
  })
}

export function useUnwatchTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (templateId: string) => api.del(`/v1/watches/${templateId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.watches() })
    },
  })
}

export function useSlackSettings() {
  return useQuery({
    queryKey: queryKeys.slackSettings(),
    queryFn: () => api.get<ApiResponse<SlackSettings>>('/v1/settings/slack'),
    staleTime: 30_000,
  })
}

export function useSaveSlackSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (webhookUrl: string) => api.post('/v1/settings/slack', { webhookUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.slackSettings() })
    },
  })
}

export function useDeleteSlackSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.del('/v1/settings/slack'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.slackSettings() })
    },
  })
}

export function useTestSlackConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<ApiResponse<SlackTestResult>>('/v1/settings/slack/test'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.slackSettings() })
    },
  })
}
