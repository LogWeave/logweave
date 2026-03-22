/**
 * Types for the live tail ring buffer and event streaming.
 */

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

export interface TailQueryOptions {
  service?: string
  /** Exact level match (e.g. 'ERROR') */
  level?: string
  /** Minimum severity threshold (e.g. 'WARN' includes WARN, ERROR, FATAL) */
  minLevel?: string
  templateId?: string
  minAnomalyScore?: number
  limit?: number
}

/** Log level severity ordering — higher number = more severe */
const LEVEL_SEVERITY: Record<string, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
}

export function levelMeetsSeverity(eventLevel: string, minLevel: string): boolean {
  const eventSev = LEVEL_SEVERITY[eventLevel.toUpperCase()] ?? 2
  const minSev = LEVEL_SEVERITY[minLevel.toUpperCase()] ?? 0
  return eventSev >= minSev
}

export interface TailQueryResult {
  events: TailEvent[]
  cursor: number
  gap?: boolean
  missedEstimate?: number
}

export interface TailBufferStats {
  tenants: number
  totalEvents: number
  memoryBytes: number
}

export interface TailBufferConfig {
  /** Max events per tenant (default 10000) */
  bufferSize: number
  /** Max age in seconds (default 60) */
  bufferSeconds: number
  /** Global memory ceiling in bytes */
  maxMemoryBytes: number
  /** Idle tenant eviction timeout in ms (default 5 min) */
  idleTimeoutMs: number
}

export const TAIL_DEFAULTS: TailBufferConfig = {
  bufferSize: 10_000,
  bufferSeconds: 60,
  maxMemoryBytes: 256 * 1024 * 1024, // 256 MB
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
}

/** Estimated bytes per TailEvent in V8 heap */
const ESTIMATED_EVENT_BYTES = 700
export { ESTIMATED_EVENT_BYTES }
