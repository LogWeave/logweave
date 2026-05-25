import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { config } from '../config'
import { api } from '../lib/api-client'
import { timeRangeToHours, useDashboardStore } from '../stores/dashboard-store'
import { levelApiParam, levelParam, queryKeys } from './query-keys'
import type {
  AlertHistoryEntry,
  AlertRule,
  ApiResponse,
  ClusteringHealthData,
  ConnectionTestResult,
  ConnectorEntry,
  CostAnalysisData,
  CostThresholds,
  DeployEntry,
  LevelCount,
  OverviewData,
  ServiceRow,
  SlackSettings,
  SlackTestResult,
  SparklineData,
  StatusCodeCount,
  TagSettings,
  TemplateEvent,
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
        templateIds: idsKey,
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

export function useChanges(minBaseline?: number) {
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
        ...(minBaseline !== undefined ? { minBaseline } : {}),
      }),
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useSpikeBaseline() {
  return useQuery({
    queryKey: queryKeys.spikeBaseline(),
    queryFn: () =>
      api.get<ApiResponse<{ minBaseline: number; isCustom: boolean }>>(
        '/v1/settings/spike-baseline',
      ),
    staleTime: 30_000,
  })
}

export function useSaveSpikeBaseline() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (minBaseline: number) => api.put('/v1/settings/spike-baseline', { minBaseline }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.spikeBaseline() })
    },
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

export function useTemplateStatusCodes(
  templateId: string | null,
  timeWindow?: { since: string; until: string } | null,
) {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: queryKeys.templateStatusCodes(
      hours,
      templateId,
      timeWindow?.since,
      timeWindow?.until,
    ),
    queryFn: () =>
      api.get<ApiResponse<StatusCodeCount[]>>('/v1/dashboard/template-status-codes', {
        hours,
        templateId: templateId ?? undefined,
        since: timeWindow?.since,
        until: timeWindow?.until,
      }),
    enabled: templateId !== null,
    staleTime: config.staleTimeMs,
  })
}

export function useDeploys(limit = 20) {
  return useQuery({
    queryKey: queryKeys.deploys(limit),
    queryFn: () => api.get<ApiResponse<DeployEntry[]>>('/v1/deploys', { limit }),
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useTemplateEvents(templateId: string | null, statusCode?: number) {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: queryKeys.templateEvents(templateId ?? '', hours, statusCode),
    queryFn: () =>
      api.get<ApiResponse<TemplateEvent[]>>(`/v1/templates/${templateId}/events`, {
        hours,
        statusCode,
        limit: 20,
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

// ---------------------------------------------------------------------------
// Alert rules + history
// ---------------------------------------------------------------------------

export function useRules() {
  return useQuery({
    queryKey: queryKeys.rules(),
    queryFn: () => api.get<ApiResponse<AlertRule[]>>('/v1/rules'),
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useAlerts(hours = 168) {
  return useQuery({
    queryKey: queryKeys.alerts(hours),
    queryFn: () => api.get<ApiResponse<AlertHistoryEntry[]>>('/v1/alerts', { hours }),
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useCreateRule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      name: string
      ruleType: 'threshold' | 'template_watch'
      config: Record<string, unknown>
      channels?: string[]
    }) => api.post<ApiResponse<AlertRule>>('/v1/rules', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rules() })
    },
  })
}

export function useUpdateRule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      ruleId,
      ...updates
    }: {
      ruleId: string
      enabled?: boolean
      name?: string
      channels?: string[]
    }) => api.put<ApiResponse<AlertRule>>(`/v1/rules/${ruleId}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rules() })
    },
  })
}

export function useDeleteRule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (ruleId: string) => api.del(`/v1/rules/${ruleId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rules() })
    },
  })
}

// ---------------------------------------------------------------------------
// Slack settings
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tag extraction settings
// ---------------------------------------------------------------------------

export function useTagSettings() {
  return useQuery({
    queryKey: queryKeys.tagSettings(),
    queryFn: () => api.get<ApiResponse<TagSettings>>('/v1/settings/tags'),
    staleTime: 30_000,
  })
}

export function useSaveTagSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (extractTags: string[]) => api.put('/v1/settings/tags', { extractTags }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tagSettings() })
    },
  })
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export function useConnectors() {
  return useQuery({
    queryKey: queryKeys.connectors(),
    queryFn: () => api.get<ApiResponse<ConnectorEntry[]>>('/v1/connectors'),
    staleTime: 30_000,
  })
}

export function useCreateConnector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; config: Record<string, unknown> }) =>
      api.post<ApiResponse<ConnectorEntry>>('/v1/connectors', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors() })
    },
  })
}

export function useTestConnector() {
  return useMutation({
    mutationFn: (connectorId: string) =>
      api.post<ApiResponse<ConnectionTestResult>>(`/v1/connectors/${connectorId}/test`),
  })
}

export function useDeleteConnector() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connectorId: string) => api.del(`/v1/connectors/${connectorId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors() })
    },
  })
}

export interface S3QuickCreateUrlResponse {
  url: string
  externalId: string
  region: string
}

export function useS3QuickCreateUrl() {
  return useMutation({
    mutationFn: (body: { bucket: string; prefix?: string; region?: string }) =>
      api.post<ApiResponse<S3QuickCreateUrlResponse>>('/v1/connectors/s3/quick-create-url', body),
  })
}

// ---------------------------------------------------------------------------
// Cost optimizer
// ---------------------------------------------------------------------------

export function useCostAnalysis() {
  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const hours = timeRangeToHours(timeRange)
  return useQuery({
    queryKey: queryKeys.costAnalysis(hours, serviceFilter, levelParam(levelFilters)),
    queryFn: () =>
      api.get<ApiResponse<CostAnalysisData>>('/v1/cost/analysis', {
        hours,
        service: serviceFilter ?? undefined,
        level: levelApiParam(levelFilters),
      }),
    refetchInterval: pollUnlessError,
    staleTime: config.staleTimeMs,
  })
}

export function useCostThresholds() {
  return useQuery({
    queryKey: queryKeys.costThresholds(),
    queryFn: () => api.get<ApiResponse<CostThresholds>>('/v1/settings/cost-thresholds'),
    staleTime: 30_000,
  })
}

export function useSaveCostThresholds() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { noiseDebugPct: number; reviewInfoPct: number; reviewWarnPct: number }) =>
      api.put('/v1/settings/cost-thresholds', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.costThresholds() })
      queryClient.invalidateQueries({ queryKey: ['cost'] })
    },
  })
}
