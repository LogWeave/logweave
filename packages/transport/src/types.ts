/**
 * Configuration options for the LogWeave Winston transport.
 *
 * Each transport instance maps to one service + one environment.
 * If you need to send logs from multiple services, create separate transport instances.
 */
export interface TransportOptions {
  /** API key for authentication (sent as Bearer token, never logged) */
  readonly apiKey: string
  /** Service name — identifies this application in LogWeave dashboards */
  readonly service: string
  /** LogWeave API endpoint. Defaults to http://localhost:3000/v1/ingest/batch for dev. */
  readonly endpoint?: string
  /** Environment tag (e.g. "production", "staging"). Sent at batch level. */
  readonly environment?: string
  /** Max events to buffer before flushing. Default: 1000 */
  readonly bufferSize?: number
  /**
   * Hard cap on retained events when the API is slow/down. Beyond this the
   * oldest buffered events are dropped (and onDrop fires) so the SDK can never
   * OOM the host application. Default: 50000.
   */
  readonly maxRetainedEvents?: number
  /** Flush interval in milliseconds. Default: 5000 */
  readonly flushIntervalMs?: number
  /** HTTP request timeout in milliseconds. Default: 2000 */
  readonly timeoutMs?: number
  /** Max retries on 5xx errors. Default: 3 */
  readonly maxRetries?: number
  /**
   * Injectable fetch function for testing.
   * Defaults to globalThis.fetch.
   */
  readonly fetch?: typeof globalThis.fetch
  /**
   * Called when a batch of events is dropped after retry exhaustion or rejection.
   * Use this to detect data loss — e.g. increment a metric or alert.
   * The callback must not throw; if it does, the error is silently caught.
   */
  readonly onDrop?: (events: readonly LogEvent[], error: Error) => void
}

/**
 * Runtime counters for observability, returned by LogWeaveTransport.getStats().
 */
export interface TransportStats {
  /** Events in the active buffer waiting to be sent (excludes an in-flight batch). */
  readonly bufferedEvents: number
  /**
   * Total events dropped over the transport's lifetime — both retention-cap
   * evictions and batches abandoned after retry exhaustion.
   */
  readonly droppedEvents: number
}

/**
 * A single log event as sent to the LogWeave API.
 *
 * Fields are flat (NOT wrapped in a meta:{} object) because the API
 * server's ingestion pipeline does not look inside a meta wrapper.
 */
export interface LogEvent {
  /** ISO 8601 timestamp */
  readonly timestamp: string
  /** Log level as-is from Winston (API server uppercases) */
  readonly level: string
  /** Log message text */
  readonly message: string
  /** All other fields spread as top-level keys */
  readonly [key: string]: unknown
}

/**
 * Batch payload sent to POST /v1/ingest/batch.
 *
 * Service and environment are set once at batch level (not per-event)
 * to reduce payload size.
 */
export interface BatchPayload {
  /** Service name from transport config */
  readonly service: string
  /** Environment from transport config */
  readonly environment?: string
  /** Array of log events */
  readonly events: readonly LogEvent[]
}
