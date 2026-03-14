/**
 * Pipeline types for log ingestion.
 *
 * Naming: camelCase (TypeScript convention). The mapping to LogMetadataRow
 * (snake_case, ClickHouse convention) happens in the ingestion endpoint.
 */

// -- Raw input --

/** Raw log event as received from the transport/SDK or external source. */
export interface RawLogEvent {
  message?: string
  msg?: string
  [key: string]: unknown
}

// -- Parser strategy --

/** Fields extracted by a LogParser (excluding message). */
export interface ExtractedFields {
  service?: string
  level?: string
  environment?: string
  statusCode?: number
  durationMs?: number
  traceId?: string
  route?: string
}

/**
 * Pluggable parser interface for different log formats.
 * MVP ships JsonLogParser. Future: LogfmtParser, FluentbitParser, PlainTextParser.
 */
export interface LogParser {
  /** Extract the log message string from a raw event. */
  extractMessage(event: Record<string, unknown>): string | undefined
  /** Extract structured fields, respecting neverExtract. */
  extractFields(
    event: Record<string, unknown>,
    neverExtract: ReadonlySet<string>,
  ): ExtractedFields
}

// -- Parse options & results --

/** Options for batch parsing. */
export interface ParseOptions {
  /** Batch-level service name, applied when event has no service field. */
  service?: string
  /** Batch-level environment, applied when event has no environment field. */
  environment?: string
  /**
   * Field names to never extract (e.g., 'user_id', 'email').
   * Plain field names, NOT JSONPath (conscious deviation from PLAN.md config format).
   * Checked DURING extraction — the field is never read from the event.
   */
  neverExtract?: ReadonlySet<string>
}

/**
 * Result of parsing a single event. Discriminated union — never throws.
 * ok=true: successfully parsed. ok=false: parse failed, skip this event.
 */
export type ParseResult =
  | { ok: true; event: ParsedEvent }
  | { ok: false; error: string; index: number }

// -- Pipeline stages --

/** Parsed event after field extraction (pipeline steps 2-3). */
export interface ParsedEvent {
  message: string
  service: string
  level: string
  environment: string
  statusCode?: number
  durationMs?: number
  traceId?: string
  route?: string
}

/**
 * Fully processed event ready for clustering (pipeline step 4 complete).
 * Does NOT include tenant_id, timestamp, source_type, source_ref —
 * those are added by the ingestion endpoint from auth context and request metadata.
 */
export interface ProcessedEvent {
  preProcessedMessage: string
  preprocessingVersion: number
  service: string
  level: string
  environment: string
  statusCode?: number
  durationMs?: number
  traceId?: string
  route?: string
}

/**
 * Post-clustering event shape (pipeline step 5 complete).
 * Defined here per issue scope but populated downstream by issue #16.
 */
export interface EnrichedEvent extends ProcessedEvent {
  /** UUIDv7 template identifier, or '0' for unclustered events. */
  templateId: string
  templateText: string
  isNewTemplate: boolean
}
