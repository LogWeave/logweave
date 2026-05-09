import type { ExtractedFields, LogParser } from './types.js'

/**
 * Extended log parser for generic JSON ingestion.
 * Supports wider field name search than JsonLogParser:
 * - Message: message, msg, log, body
 * - All standard ExtractedFields
 *
 * Used by POST /v1/ingest/logs (generic HTTP endpoint).
 * The existing JsonLogParser is unchanged for the Winston transport.
 */

const MESSAGE_FIELDS = ['message', 'msg', 'log', 'body'] as const

const FIELD_MAP: ReadonlyArray<{
  output: keyof ExtractedFields
  inputs: readonly string[]
  coerce: 'string' | 'number'
}> = [
  { output: 'service', inputs: ['service'], coerce: 'string' },
  { output: 'level', inputs: ['level', 'lvl', 'severity'], coerce: 'string' },
  { output: 'environment', inputs: ['environment', 'env'], coerce: 'string' },
  { output: 'statusCode', inputs: ['status_code', 'statusCode', 'http_status'], coerce: 'number' },
  { output: 'durationMs', inputs: ['duration_ms', 'durationMs', 'duration'], coerce: 'number' },
  { output: 'traceId', inputs: ['trace_id', 'traceId'], coerce: 'string' },
  { output: 'route', inputs: ['route', 'http_route', 'path'], coerce: 'string' },
]

function readField(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in source && source[key] != null) {
      return source[key]
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class GenericLogParser implements LogParser {
  extractMessage(event: Record<string, unknown>): string | undefined {
    for (const field of MESSAGE_FIELDS) {
      const val = event[field]
      if (typeof val === 'string') return val
    }
    return undefined
  }

  extractFields(
    event: Record<string, unknown>,
    neverExtract: ReadonlySet<string>,
  ): ExtractedFields {
    const fields: ExtractedFields = {}
    const sub = isRecord(event.fields) ? event.fields : undefined

    for (const { output, inputs, coerce } of FIELD_MAP) {
      if (inputs.some((name) => neverExtract.has(name) || neverExtract.has(`fields.${name}`))) continue
      let raw = readField(event, inputs)
      if (raw === undefined && sub) {
        raw = readField(sub, inputs)
      }
      if (raw === undefined) continue

      if (coerce === 'number') {
        const n = Number(raw)
        if (Number.isFinite(n)) {
          fields[output] = n as never
        }
      } else {
        // Match JsonLogParser: drop empty strings rather than passing them
        // through as a non-undefined falsy value (callers treat the field
        // as missing in either case).
        const s = String(raw)
        if (s.length > 0) fields[output] = s as never
      }
    }

    return fields
  }
}
