import { z } from 'zod'

// ---------------------------------------------------------------------------
// Generic response envelope
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  data: T
  meta: {
    hours: number
    since?: string
    limit?: number
    offset?: number
    count: number
    fetchedAt: string
    timeRange?: string
    dataRetention?: string
    message?: string
  }
}

// ---------------------------------------------------------------------------
// Shared base schemas
// ---------------------------------------------------------------------------

export const timeRangeSchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
})

export const paginatedSchema = timeRangeSchema.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

// ---------------------------------------------------------------------------
// Reusable level filter field
// ---------------------------------------------------------------------------

const levelFilterField = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))

// ---------------------------------------------------------------------------
// Per-endpoint query schemas
// ---------------------------------------------------------------------------

export const templatesQuerySchema = paginatedSchema.extend({
  service: z.string().optional(),
  sort: z.enum(['occurrence', 'error', 'recent']).default('occurrence'),
  level: levelFilterField,
})

export const servicesQuerySchema = paginatedSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  level: levelFilterField,
})

export const volumeQuerySchema = timeRangeSchema.extend({
  service: z.string().optional(),
  offset: z.coerce.number().int().min(0).max(720).default(0),
  level: levelFilterField,
})

export const overviewQuerySchema = timeRangeSchema.extend({
  level: levelFilterField,
  compare: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export const sparklineQuerySchema = timeRangeSchema.extend({
  template_ids: z
    .string()
    .min(1)
    .transform((s) => s.split(','))
    .pipe(z.array(z.string().min(1)).min(1).max(20)),
  level: levelFilterField,
})

export const clusteringHealthQuerySchema = timeRangeSchema.extend({
  level: levelFilterField,
})

export const changesQuerySchema = z
  .object({
    hours: z.coerce.number().int().min(1).max(720).default(24),
    since: z
      .string()
      .datetime({ offset: true })
      .optional()
      .refine((s) => !s || new Date(s).getTime() <= Date.now(), {
        message: 'since must not be in the future',
      })
      .refine((s) => !s || Date.now() - new Date(s).getTime() <= 720 * 3_600_000, {
        message: 'since must be within the last 30 days',
      })
      .refine((s) => !s || Date.now() - new Date(s).getTime() >= 600_000, {
        message: 'since must be at least 10 minutes ago',
      }),
    deploy_id: z.string().min(1).optional(),
    service: z.string().optional(),
    threshold: z.coerce.number().min(1).max(100).default(3),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    level: levelFilterField,
  })

export const levelsQuerySchema = timeRangeSchema.extend({
  service: z.string().optional(),
})

export const templateStatusCodesQuerySchema = timeRangeSchema.extend({
  template_id: z.string().min(1),
})

export const templateTrendSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
})

export type TemplateTrendQuery = z.infer<typeof templateTrendSchema>

export const templateSearchSchema = paginatedSchema.extend({
  q: z.string().min(3, 'Search query must be at least 3 characters'),
  level: levelFilterField,
  mode: z.enum(['substring', 'semantic']).default('substring'),
})

export type TemplateSearchQuery = z.infer<typeof templateSearchSchema>

// Composite endpoint schemas — simpler than dashboard schemas, just hours + level
export const compositeTimeSchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  level: levelFilterField,
})

export type CompositeTimeQuery = z.infer<typeof compositeTimeSchema>

// ---------------------------------------------------------------------------
// Inferred query types
// ---------------------------------------------------------------------------

export type TemplatesQuery = z.infer<typeof templatesQuerySchema>
export type ServicesQuery = z.infer<typeof servicesQuerySchema>
export type VolumeQuery = z.infer<typeof volumeQuerySchema>
export type OverviewQuery = z.infer<typeof overviewQuerySchema>
export type SparklineQuery = z.infer<typeof sparklineQuerySchema>
export type ClusteringHealthQuery = z.infer<typeof clusteringHealthQuerySchema>
export type ChangesQuery = z.infer<typeof changesQuerySchema>
export type LevelsQuery = z.infer<typeof levelsQuerySchema>
export type TemplateStatusCodesQuery = z.infer<typeof templateStatusCodesQuerySchema>

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface TemplateRow {
  templateId: string
  templateText: string
  service: string
  occurrenceCount: number
  errorCount: number
  avgDurationMs: number
  maxAnomalyScore: number
  isNewToday: boolean
  firstSeen: string
  lastSeen: string
}

export interface ServiceRow {
  service: string
  logCount: number
  errorCount: number
  warnCount: number
  errorRate: number
  warnRate: number
  newTemplateCount: number
  avgAnomalyScore: number
}

export interface VolumePoint {
  intervalStart: string
  service: string
  logCount: number
  errorCount: number
}

export interface VolumeData {
  current: VolumePoint[]
  previous?: VolumePoint[]
}

export interface OverviewData {
  totalEvents: number
  totalTemplates: number
  newTemplatesToday: number
  unclusteredCount: number
  errorRate: number
  serviceCount: number
  previous?: {
    totalEvents: number
    totalTemplates: number
    newTemplatesToday: number
    unclusteredCount: number
    errorRate: number
    serviceCount: number
  }
}

export interface SparklineData {
  [templateId: string]: Array<{ intervalStart: string; count: number }>
}

export interface ClusteringHealthData {
  totalEvents: number
  clusteredEvents: number
  unclusteredEvents: number
  uniqueTemplates: number
  compressionRatio: number
  trend: Array<{
    intervalStart: string
    total: number
    unclustered: number
    ratio: number
  }>
}

export interface ChangeEvent {
  type: 'new' | 'spike' | 'resolved'
  templateId: string
  templateText: string
  service: string
  currentCount: number
  previousCount: number
  ratio: number
  firstSeen?: string
  lastSeen?: string
}

export interface LevelCount {
  level: string
  count: number
}

export interface StatusCodeCount {
  statusCode: number
  count: number
}

// ---------------------------------------------------------------------------
// Composite endpoint response types
// ---------------------------------------------------------------------------

export interface CrossServiceTemplate {
  templateId: string
  templateText: string
  truncated?: boolean
  trend?: string
  servicesAffected: string[]
  occurrenceCount: number
  errorCount: number
  avgDurationMs: number
  maxAnomalyScore: number
  firstSeen: string
  lastSeen: string
}

export interface TemplateDetailData {
  templateId: string
  templateText: string
  truncated?: boolean
  servicesAffected: string[]
  occurrenceCount: number
  errorCount: number
  avgDurationMs: number
  maxAnomalyScore: number
  firstSeen: string
  lastSeen: string
  sparkline: Array<{ intervalStart: string; count: number }>
  statusCodes: StatusCodeCount[]
}

export interface ServiceHealthData {
  service: string
  logCount: number
  errorCount: number
  warnCount: number
  errorRate: number
  warnRate: number
  topErrorPatterns: CrossServiceTemplate[]
  volumeTrend: Array<{ intervalStart: string; logCount: number; errorCount: number }>
}

export interface OverviewCompositeData {
  totalEvents: number
  totalTemplates: number
  newTemplatesToday: number
  unclusteredCount: number
  errorRate: number
  serviceCount: number
  topErrorPatterns: CrossServiceTemplate[]
}
