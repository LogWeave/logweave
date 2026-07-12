/**
 * OTLP/HTTP JSON protocol adapter.
 *
 * Flattens the nested OTLP ExportLogsServiceRequest structure into
 * flat event objects that can be passed to ingestBatch().
 *
 * This is NOT a LogParser — it is a protocol adapter that runs BEFORE
 * the parser. The OTLP structure is too different from flat JSON for
 * the LogParser interface.
 */

// ---------------------------------------------------------------------------
// OTLP types (minimal — only what we extract)
// ---------------------------------------------------------------------------

interface OtlpAttribute {
  key: string
  value: { stringValue?: string; intValue?: string | number; boolValue?: boolean }
}

interface OtlpLogRecord {
  timeUnixNano?: string
  severityText?: string
  severityNumber?: number
  body?: { stringValue?: string }
  traceId?: string
  attributes?: OtlpAttribute[]
}

interface OtlpScopeLog {
  logRecords?: OtlpLogRecord[]
}

interface OtlpResourceLog {
  resource?: { attributes?: OtlpAttribute[] }
  scopeLogs?: OtlpScopeLog[]
}

interface OtlpExportRequest {
  resourceLogs?: OtlpResourceLog[]
}

// ---------------------------------------------------------------------------
// Flattened event output
// ---------------------------------------------------------------------------

export interface OtlpFlatEvent {
  message: string
  service: string
  level: string
  environment: string
  timestamp: string
  traceId?: string
  statusCode?: number
  route?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAttr(attrs: OtlpAttribute[] | undefined, key: string): string | undefined {
  const attr = attrs?.find((a) => a.key === key)
  if (!attr) return undefined
  return (
    attr.value.stringValue ??
    (attr.value.intValue !== undefined ? String(attr.value.intValue) : undefined)
  )
}

function getIntAttr(attrs: OtlpAttribute[] | undefined, key: string): number | undefined {
  const attr = attrs?.find((a) => a.key === key)
  if (!attr) return undefined
  const val = attr.value.intValue ?? attr.value.stringValue
  if (val === undefined) return undefined
  const n = Number(val)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Map OTel severityNumber to level string.
 * https://opentelemetry.io/docs/specs/otel/logs/data-model/#severity-fields
 */
function severityNumberToLevel(n: number): string {
  if (n <= 4) return 'TRACE'
  if (n <= 8) return 'DEBUG'
  if (n <= 12) return 'INFO'
  if (n <= 16) return 'WARN'
  if (n <= 20) return 'ERROR'
  return 'FATAL'
}

function nanoToIso(nano: string): string {
  // Nanosecond timestamps exceed float64 precision — truncate string to milliseconds
  // e.g., '1679000000123456789' → '1679000000123'
  const msStr = nano.length > 13 ? nano.slice(0, 13) : nano
  return new Date(Number(msStr)).toISOString()
}

function normalizeTraceId(raw: string): string {
  const stripped = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw
  return stripped.toLowerCase()
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Flatten an OTLP ExportLogsServiceRequest into an array of flat events.
 * Skips log records with empty body (metadata-only).
 */
export function otlpToEvents(body: unknown): OtlpFlatEvent[] {
  const request = body as OtlpExportRequest
  const resourceLogs = request?.resourceLogs
  if (!Array.isArray(resourceLogs)) return []

  const events: OtlpFlatEvent[] = []

  for (const rl of resourceLogs) {
    const resourceAttrs = rl.resource?.attributes
    const service = getAttr(resourceAttrs, 'service.name') ?? ''
    const environment = getAttr(resourceAttrs, 'deployment.environment') ?? ''

    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const message = lr.body?.stringValue
        if (!message) continue // Skip empty body records

        const level =
          lr.severityText ??
          (lr.severityNumber !== undefined ? severityNumberToLevel(lr.severityNumber) : '')

        const timestamp = lr.timeUnixNano ? nanoToIso(lr.timeUnixNano) : new Date().toISOString()

        const traceId = lr.traceId ? normalizeTraceId(lr.traceId) : undefined
        const statusCode =
          getIntAttr(lr.attributes, 'http.status_code') ??
          getIntAttr(lr.attributes, 'http.response.status_code')
        const route = getAttr(lr.attributes, 'http.route')

        events.push({
          message,
          service,
          level,
          environment,
          timestamp,
          traceId,
          statusCode,
          route,
        })
      }
    }
  }

  return events
}
