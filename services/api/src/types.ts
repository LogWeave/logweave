export interface ClustererHealth {
  consecutiveFailures: number
  lastChecked: number
}

export interface LogMetadataRow {
  id?: string
  tenant_id: string
  timestamp: string
  service: string
  level: string
  environment: string
  template_id?: string
  template_text?: string
  is_new_template?: number
  anomaly_score?: number
  status_code?: number
  duration_ms?: number
  trace_id?: string
  route?: string
  source_type: string
  source_ref: string
  pre_processed_message?: string | null
  preprocessing_version?: number
}
