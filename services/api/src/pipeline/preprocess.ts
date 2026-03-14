import type { ParsedEvent, ProcessedEvent } from './types.js'

/** Bump when regex patterns change to track which version processed a message. */
export const PREPROCESSING_VERSION = 1

/**
 * Compiled regex patterns applied in strict order.
 * Order matters — see inline comments for rationale.
 */
const PATTERNS: ReadonlyArray<{ regex: RegExp; replacement: string }> = [
  // 1. UUID — must run before HEX and ID to prevent partial mangling
  {
    regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: '<UUID>',
  },
  // 2. ISO timestamp — must run before ID (timestamps contain \d{6,} substrings)
  {
    regex: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    replacement: '<TS>',
  },
  // 3. Email — case-insensitive, TLD required to avoid false positives
  {
    regex: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
    replacement: '<EMAIL>',
  },
  // 4. IPv4 — word boundaries prevent matching inside larger numbers
  {
    regex: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
    replacement: '<IP>',
  },
  // 5. Long hex (16+ chars) — after UUID (full UUIDs already replaced)
  {
    regex: /\b[0-9a-f]{16,}\b/gi,
    replacement: '<HEX>',
  },
  // 6. Large numeric ID (6+ digits) — broadest pattern, last.
  //    Preserves ports (8080 = 4 digits), status codes (404 = 3 digits)
  {
    regex: /\b\d{6,}\b/g,
    replacement: '<ID>',
  },
]

/**
 * Strip high-cardinality values from a log message before clustering.
 * Pure function — no side effects, no state.
 */
export function preprocessMessage(message: string): string {
  let result = message
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement)
  }
  return result
}

/**
 * Compose a ParsedEvent into a ProcessedEvent by applying preprocessing.
 * Convenience function — keeps composition logic inside the pipeline module.
 */
export function processEvent(parsed: ParsedEvent): ProcessedEvent {
  return {
    preProcessedMessage: preprocessMessage(parsed.message),
    preprocessingVersion: PREPROCESSING_VERSION,
    service: parsed.service,
    level: parsed.level,
    environment: parsed.environment,
    statusCode: parsed.statusCode,
    durationMs: parsed.durationMs,
    traceId: parsed.traceId,
    route: parsed.route,
  }
}
