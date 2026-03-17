import { z } from 'zod'

// ---------------------------------------------------------------------------
// Generic response envelope
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  data: T
  meta: {
    hours: number
    limit?: number
    offset?: number
    count: number
    fetchedAt: string
  }
}

// ---------------------------------------------------------------------------
// Shared base schemas
// ---------------------------------------------------------------------------

export const timeRangeSchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).default(24),
})

export const paginatedSchema = timeRangeSchema.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

// ---------------------------------------------------------------------------
// Per-endpoint query schemas
// ---------------------------------------------------------------------------

export const templatesQuerySchema = paginatedSchema.extend({
  service: z.string().optional(),
  sort: z.enum(['occurrence', 'error', 'recent']).default('occurrence'),
})

export const servicesQuerySchema = paginatedSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(100),
})

export const volumeQuerySchema = timeRangeSchema.extend({
  service: z.string().optional(),
  offset: z.coerce.number().int().min(0).max(168).default(0),
})

export const overviewQuerySchema = timeRangeSchema

export const sparklineQuerySchema = timeRangeSchema.extend({
  template_ids: z
    .string()
    .min(1)
    .transform((s) => s.split(','))
    .pipe(z.array(z.string().min(1)).min(1).max(20)),
})

export const clusteringHealthQuerySchema = timeRangeSchema

// ---------------------------------------------------------------------------
// Inferred query types
// ---------------------------------------------------------------------------

export type TemplatesQuery = z.infer<typeof templatesQuerySchema>
export type ServicesQuery = z.infer<typeof servicesQuerySchema>
export type VolumeQuery = z.infer<typeof volumeQuerySchema>
export type OverviewQuery = z.infer<typeof overviewQuerySchema>
export type SparklineQuery = z.infer<typeof sparklineQuerySchema>
export type ClusteringHealthQuery = z.infer<typeof clusteringHealthQuerySchema>

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
