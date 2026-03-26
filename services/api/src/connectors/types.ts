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

export interface ElasticsearchConnectorConfig {
  type: 'elasticsearch'
  /** Base URL of the ES/OpenSearch cluster, e.g. https://es.example.com:9200 */
  url: string
  /** Index name or pattern to search, e.g. 'logs-*' */
  index: string
  /** Optional basic-auth username */
  username?: string
  /** Optional basic-auth password */
  password?: string
  /** Optional API key (alternative to username/password) */
  apiKey?: string
  /** Field name containing the log message (default: 'message') */
  messageField?: string
  /** Field name containing the timestamp (default: '@timestamp') */
  timestampField?: string
}

export interface LokiConnectorConfig {
  type: 'loki'
  /** Base URL of the Loki server, e.g. http://loki:3100 */
  url: string
  /** LogQL stream selector, e.g. '{app="payments"}' */
  streamSelector: string
  /** Multi-tenant org ID header (X-Scope-OrgID). Leave blank for single-tenant. */
  orgId?: string
  /** Optional basic-auth username */
  username?: string
  /** Optional basic-auth password */
  password?: string
}

export interface FilesystemConnectorConfig {
  type: 'filesystem'
  /** Absolute base directory path containing log files */
  basePath: string
  /** Glob pattern within basePath for matching log files */
  filePattern: string
  /** Log format: text (one line per entry) or jsonl */
  logFormat: 'jsonl' | 'text'
}

export type ConnectorConfig =
  | S3ConnectorConfig
  | ElasticsearchConnectorConfig
  | LokiConnectorConfig
  | FilesystemConnectorConfig

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
