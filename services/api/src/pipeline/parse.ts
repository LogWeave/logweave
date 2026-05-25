import type { ExtractedFields, LogParser, ParsedEvent, ParseOptions, ParseResult } from './types.js'

/**
 * Field extraction map for JSON log events.
 * Maps output field name → possible input field names (checked in order).
 * Checked at top level first, then inside a `fields` sub-object.
 */
const FIELD_MAP: ReadonlyArray<{
  output: keyof ExtractedFields
  inputs: readonly string[]
  coerce: 'string' | 'number'
}> = [
  { output: 'service', inputs: ['service'], coerce: 'string' },
  { output: 'level', inputs: ['level', 'lvl'], coerce: 'string' },
  { output: 'environment', inputs: ['environment', 'env'], coerce: 'string' },
  { output: 'statusCode', inputs: ['status_code', 'statusCode'], coerce: 'number' },
  { output: 'durationMs', inputs: ['duration_ms', 'durationMs'], coerce: 'number' },
  { output: 'traceId', inputs: ['trace_id', 'traceId'], coerce: 'string' },
  { output: 'route', inputs: ['route'], coerce: 'string' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Try to read a value from a record by checking multiple possible keys.
 * Returns undefined if none found.
 */
function readField(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in source && source[key] != null) {
      return source[key]
    }
  }
  return undefined
}

/**
 * MVP JSON log parser. Checks `message`/`msg` for the log message,
 * and extracts structured fields from top-level and `fields` sub-object.
 */
export class JsonLogParser implements LogParser {
  extractMessage(event: Record<string, unknown>): string | undefined {
    const msg = event.message ?? event.msg
    return typeof msg === 'string' ? msg : undefined
  }

  extractFields(
    event: Record<string, unknown>,
    neverExtract: ReadonlySet<string>,
  ): ExtractedFields {
    const fields: ExtractedFields = {}
    const nested = isRecord(event.fields) ? event.fields : undefined

    for (const { output, inputs, coerce } of FIELD_MAP) {
      // Check if ANY input name is on the never_extract list
      const blocked = inputs.some(
        (name) => neverExtract.has(name) || neverExtract.has(`fields.${name}`),
      )
      if (blocked) continue

      // Check top-level first, then nested `fields` object
      let raw = readField(event, inputs)
      if (raw === undefined && nested) {
        raw = readField(nested, inputs)
      }
      if (raw === undefined) continue

      if (coerce === 'number') {
        const num = Number(raw)
        if (!Number.isNaN(num)) {
          ;(fields as Record<string, unknown>)[output] = num
        }
      } else {
        const str = String(raw)
        if (str.length > 0) {
          ;(fields as Record<string, unknown>)[output] = str
        }
      }
    }

    return fields
  }
}

const defaultParser = new JsonLogParser()

/**
 * Parse a single raw event into a ParsedEvent.
 * Returns a discriminated union — never throws.
 */
export function parseEvent(
  raw: unknown,
  index: number,
  options?: ParseOptions,
  parser: LogParser = defaultParser,
): ParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: 'Event is not an object', index }
  }

  const message = parser.extractMessage(raw)
  if (message === undefined) {
    return {
      ok: false,
      error: 'Event has no valid message field (checked message, msg)',
      index,
    }
  }

  const neverExtract = options?.neverExtract ?? new Set<string>()
  const extracted = parser.extractFields(raw, neverExtract)

  const event: ParsedEvent = {
    message,
    service: extracted.service ?? options?.service ?? '',
    level: extracted.level ?? '',
    environment: extracted.environment ?? options?.environment ?? '',
    statusCode: extracted.statusCode,
    durationMs: extracted.durationMs,
    traceId: extracted.traceId,
    route: extracted.route,
  }

  return { ok: true, event }
}

/**
 * Parse a batch of raw events. Successes and failures are separated —
 * individual parse failures skip the event, don't reject the batch.
 */
export function parseBatch(
  events: unknown[],
  options?: ParseOptions,
  parser: LogParser = defaultParser,
): { parsed: ParsedEvent[]; errors: ParseResult[] } {
  const parsed: ParsedEvent[] = []
  const errors: ParseResult[] = []

  for (let i = 0; i < events.length; i++) {
    const result = parseEvent(events[i], i, options, parser)
    if (result.ok) {
      parsed.push(result.event)
    } else {
      errors.push(result)
    }
  }

  return { parsed, errors }
}
