export interface TailEvent {
  seq: number
  timestamp: string
  service: string
  level: string
  templateId: string
  templateText: string
  preProcessedMessage?: string
  anomalyScore: number
  statusCode: number
  durationMs: number
  traceId: string
  route: string
}

export interface TailFilterOptions {
  service?: string
  level?: string
  templateId?: string
  minAnomalyScore?: number
  limit?: number
}
