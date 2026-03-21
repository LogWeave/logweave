/**
 * Pluggable log source adapter types.
 * Designed for multiple backends: S3, Azure Blob, GCS, local filesystem.
 */

// ---------------------------------------------------------------------------
// Connector config — stored in tenant_connectors table
// ---------------------------------------------------------------------------

export interface S3ConnectorConfig {
  type: 's3'
  bucket: string
  prefix: string
  pathPattern: string // e.g. '{prefix}{service}/{year}/{month}/{day}/{hour}/'
  region: string
  logFormat: 'jsonl' | 'text'
  compression: 'none' | 'gzip'
  /** MinIO/dev-only: S3-compatible endpoint URL */
  endpoint?: string
  /** MinIO/dev-only: required for path-style access */
  forcePathStyle?: boolean
  /** MinIO/dev-only: static access key */
  accessKeyId?: string
  /** MinIO/dev-only: static secret key */
  secretAccessKey?: string
}

export type ConnectorConfig = S3ConnectorConfig
// Future: | AzureBlobConnectorConfig | GCSConnectorConfig | LocalConnectorConfig

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface FetchRawLogsParams {
  config: ConnectorConfig
  templateText: string
  service: string
  timeRange: { start: Date; end: Date }
  limit: number
  sourceRef?: string
  cursor?: string
}

export interface RawLogLine {
  timestamp?: string
  message: string
  source: string
  sourceUrl?: string
}

export interface RawLogResult {
  lines: RawLogLine[]
  hasMore: boolean
  cursor?: string
  filesScanned: number
  bytesScanned: number
  truncated: boolean
  truncatedReason?: 'file_limit' | 'timeout'
}

export interface ConnectionTestResult {
  success: boolean
  message: string
  filesFound?: number
}

export interface LogSourceAdapter {
  readonly type: string

  testConnection(config: ConnectorConfig): Promise<ConnectionTestResult>

  fetchRawLogs(params: FetchRawLogsParams): Promise<RawLogResult>
}

// ---------------------------------------------------------------------------
// Scan limits
// ---------------------------------------------------------------------------

export const SCAN_DEFAULTS = {
  maxFiles: 20,
  maxTimeoutMs: 30_000,
  defaultLimit: 50,
  maxLimit: 100,
  defaultHours: 1,
  maxHours: 24,
} as const
