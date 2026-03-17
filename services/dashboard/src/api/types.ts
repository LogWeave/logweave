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

export interface ClusteringHealthData {
  totalEvents: number
  clusteredEvents: number
  unclusteredEvents: number
  uniqueTemplates: number
  compressionRatio: number
  trend: Array<{ intervalStart: string; total: number; unclustered: number; ratio: number }>
}
