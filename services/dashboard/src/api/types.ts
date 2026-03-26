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

export interface ChangesData {
  new: ChangeEvent[]
  spike: ChangeEvent[]
  resolved: ChangeEvent[]
}

export interface ClusteringHealthData {
  totalEvents: number
  clusteredEvents: number
  unclusteredEvents: number
  uniqueTemplates: number
  compressionRatio: number
  trend: Array<{ intervalStart: string; total: number; unclustered: number; ratio: number }>
}

export interface LevelCount {
  level: string
  count: number
}

export interface StatusCodeCount {
  statusCode: number
  count: number
}

export interface WatchEntry {
  templateId: string
}

export interface SlackSettings {
  configured: boolean
  lastTestStatus: 'success' | 'failed' | null
  lastTestAt: string | null
}

export interface TemplateEvent {
  timestamp: string
  traceId: string
  route: string
  durationMs: number
  level: string
  service: string
  statusCode: number
}

export interface DeployEntry {
  deployId: string
  service: string
  version: string | null
  commitSha: string | null
  timestamp: string
}

export interface TagSettings {
  extractTags: string[]
}

export interface SlackTestResult {
  success: boolean
  error?: string
}

export interface OnboardingStatus {
  hasEvents: boolean
  mcpConnected: boolean
  clusteringConfigured: boolean
  dismissed: boolean
}

export interface ThresholdConfig {
  metric: 'error_count' | 'warn_count' | 'log_count'
  service: string
  operator: string
  value: number
  windowMinutes: number
  environment?: string
}

export interface TemplateWatchConfig {
  templateId: string
  templateText: string
}

export interface AlertRule {
  ruleId: string
  name: string
  ruleType: 'threshold' | 'template_watch'
  enabled: boolean
  config: ThresholdConfig | TemplateWatchConfig
  channels: string[]
}

export interface AlertHistoryEntry {
  alertId: string
  ruleId: string
  ruleType: string
  ruleName: string
  firedAt: string
  metricValue: number
  thresholdValue: number
  details: Record<string, unknown>
  channelsNotified: string[]
}

export interface CostPattern {
  templateId: string
  template: string
  service: string
  level: string
  count: number
  volumePct: number
  classification: 'noise' | 'review'
  suggestion: string
}

export interface CostAnalysisSummary {
  totalPatternsAnalyzed: number
  noiseCount: number
  reviewCount: number
  keepCount: number
  potentialReductionPct: number
}

export interface CostThresholds {
  noiseDebugPct: number
  reviewInfoPct: number
  reviewWarnPct: number
  isCustom: boolean
}

export interface CostAnalysisData {
  summary: CostAnalysisSummary
  patterns: CostPattern[]
  thresholds: CostThresholds
}
