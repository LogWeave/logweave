/**
 * LogWeave Winston Transport.
 *
 * Extends winston-transport to buffer log events and send them in batches
 * to the LogWeave API.
 *
 * Two modes:
 * - Default (in-memory): never blocks the application logger; events live in a
 *   bounded in-memory buffer and are lost on crash or sustained API outage.
 * - Durable (`durable: true`, #282): events are written to a crash-safe on-disk
 *   spool (fsync-on-insert) and delivered by a background pump (at-least-once,
 *   survives restarts). Under backpressure it bounded-blocks the logger rather
 *   than dropping silently — a deliberate trade of non-blocking for no-loss.
 *   Requires Node >= 22.5 (built-in node:sqlite).
 *
 * Each transport instance maps to one service + one environment.
 * If you need to send logs from multiple services, create separate instances.
 *
 * Known limitation: the LogWeave API server has a 1MB body limit.
 * For very large log messages, ensure your buffer size keeps batches under 1MB.
 */
import TransportStream from 'winston-transport'
import { BufferManager } from './buffer.js'
import { retryFetch } from './retry.js'
import { SpoolWriter } from './spool/backpressure.js'
import { DEFAULT_MAX_RETAINED_EVENTS } from './spool/memory-spool.js'
import { Pump } from './spool/pump.js'
import { SqliteSpoolStore } from './spool/sqlite-spool.js'
import type { BatchPayload, LogEvent, TransportOptions, TransportStats } from './types.js'

const DEFAULT_ENDPOINT = 'http://localhost:3000/v1/ingest/batch'
const DEFAULT_BUFFER_SIZE = 1000
const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 2000
const DEFAULT_MAX_RETRIES = 3
const CLOSE_TIMEOUT_MS = 2000
const CLOSE_DRAIN_POLL_MS = 50

/** Keys to exclude when extracting metadata from Winston info */
const EXCLUDED_KEYS = new Set(['level', 'message', 'timestamp'])

/**
 * Default durable spool path: per-service so two transports don't share a file
 * (the pump stamps each batch with its own service). In the current working dir.
 */
function defaultSpoolPath(service: string): string {
  const safe = service.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `logweave-spool-${safe}.db`
}

let productionWarningShown = false

export class LogWeaveTransport extends TransportStream {
  private readonly apiKey: string
  private readonly service: string
  private readonly environment: string | undefined
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchFn: typeof globalThis.fetch
  private readonly onDrop: ((events: readonly LogEvent[], error: Error) => void) | undefined
  // Non-durable (default) path: in-memory double buffer.
  private readonly buffer: BufferManager | null = null
  // Durable path (#282): crash-safe spool + background pump + backpressure.
  private readonly spool: SqliteSpoolStore | null = null
  private readonly spoolWriter: SpoolWriter | null = null
  private readonly pump: Pump | null = null
  private closeController: AbortController | null = null
  private closing = false
  private droppedEvents = 0

  constructor(opts: TransportOptions) {
    super(opts as never)

    if (!opts.apiKey) {
      throw new Error('[LogWeave] apiKey is required')
    }
    if (!opts.service) {
      throw new Error('[LogWeave] service is required')
    }

    this.apiKey = opts.apiKey
    this.service = opts.service
    this.environment = opts.environment
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.onDrop = opts.onDrop

    // Warn if using default endpoint in production
    if (
      !productionWarningShown &&
      !opts.endpoint &&
      typeof process !== 'undefined' &&
      process.env.NODE_ENV === 'production'
    ) {
      console.warn(
        '[LogWeave] using default endpoint (localhost:3000) in production — set the endpoint option',
      )
      productionWarningShown = true
    }

    if (opts.durable) {
      // Durable path: spool to disk (fsync-on-insert), drain via a background
      // pump, apply backpressure on a full spool. Constructing SqliteSpoolStore
      // throws a clear error on Node < 22.5.
      const spool = new SqliteSpoolStore({
        path: opts.spoolPath ?? defaultSpoolPath(this.service),
      })
      this.spool = spool
      this.spoolWriter = new SpoolWriter({
        spool,
        maxSpooledEvents: opts.maxSpooledEvents ?? DEFAULT_MAX_RETAINED_EVENTS,
        blockMs: opts.blockMs,
        onBackpressure: opts.onBackpressure,
        onDrop: (events, error) => this.handleDrop(events, error),
      })
      this.pump = new Pump({
        spool,
        endpoint: this.endpoint,
        apiKey: this.apiKey,
        service: this.service,
        environment: this.environment,
        batchSize: opts.bufferSize ?? DEFAULT_BUFFER_SIZE,
        timeoutMs: this.timeoutMs,
        fetchFn: this.fetchFn,
        onDrop: (events, error) => this.handleDrop(events, error),
      })
      this.pump.start()
      return
    }

    this.buffer = new BufferManager({
      bufferSize: opts.bufferSize ?? DEFAULT_BUFFER_SIZE,
      maxRetainedEvents: opts.maxRetainedEvents,
      flushIntervalMs: opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      onFlush: (events) => this.sendBatch(events),
      onDrop: (events, error) => this.handleDrop(events, error),
    })
  }

  /**
   * Snapshot of runtime counters for observability.
   */
  getStats(): TransportStats {
    return {
      bufferedEvents: this.spool ? this.spool.count() : (this.buffer?.size() ?? 0),
      droppedEvents: this.droppedEvents,
    }
  }

  /**
   * Central drop handler: counts the loss and forwards to the user's onDrop.
   * Used both for retention-cap evictions and retry-exhausted batches.
   */
  private handleDrop(events: readonly LogEvent[], error: Error): void {
    this.droppedEvents += events.length
    if (this.onDrop) {
      try {
        this.onDrop(events, error)
      } catch {
        // onDrop must never throw back into the transport
      }
    }
  }

  /**
   * Called by Winston for each log entry.
   * Pushes the event to the buffer and calls callback() synchronously.
   * NEVER blocks the application logger.
   */
  log(info: Record<string | symbol, unknown>, callback: () => void): void {
    const event = this.extractEvent(info)

    if (this.spoolWriter) {
      // Durable mode: persist (fsync) before acking, and let backpressure flow
      // back to the Winston stream by deferring callback() until enqueue settles.
      this.spoolWriter
        .enqueue(event)
        .catch((err) => this.handleDrop([event], err as Error))
        .finally(() => callback())
      return
    }

    this.buffer?.push(event)
    callback()
  }

  /**
   * Extract a LogEvent from Winston's info object.
   * All non-standard keys are spread as top-level fields (NOT wrapped in meta:{}).
   */
  private extractEvent(info: Record<string | symbol, unknown>): LogEvent {
    const event: Record<string, unknown> = {
      timestamp: (info.timestamp as string) ?? new Date().toISOString(),
      level: info.level as string,
      message: info.message as string,
    }

    // Spread all other string keys as top-level fields
    for (const key of Object.keys(info)) {
      if (!EXCLUDED_KEYS.has(key)) {
        event[key] = info[key]
      }
    }

    return event as unknown as LogEvent
  }

  /**
   * Send a batch of events to the LogWeave API.
   */
  private async sendBatch(events: readonly LogEvent[]): Promise<void> {
    if (events.length === 0) return

    const payload: BatchPayload = {
      service: this.service,
      environment: this.environment,
      events,
    }

    const response = await retryFetch(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      {
        maxRetries: this.maxRetries,
        timeoutMs: this.timeoutMs,
        fetchFn: this.fetchFn,
        signal: this.closeController?.signal,
      },
    )

    if (response === null && !this.closeController?.signal.aborted) {
      this.handleDrop(events, new Error(`[LogWeave] batch of ${events.length} events dropped`))
    }
  }

  /**
   * Flush remaining events and shut down.
   * Awaits any in-flight flush, then drains and sends remaining buffer.
   * Times out after 2s if the whole sequence hangs.
   * Aborts any inflight retries via AbortController.
   */
  async closeAsync(): Promise<void> {
    if (this.closing) return
    this.closing = true

    // Durable mode: give the pump a bounded window to drain, then stop it and
    // close the spool. Anything still spooled is on disk (fsynced) and resumes
    // on the next start — no loss.
    if (this.pump && this.spool) {
      const deadline = Date.now() + CLOSE_TIMEOUT_MS
      while (this.spool.count() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, CLOSE_DRAIN_POLL_MS)
          timer.unref()
        })
      }
      await this.pump.stop()
      this.spool.close()
      return
    }

    const buffer = this.buffer
    if (!buffer) return

    this.closeController = new AbortController()

    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS)
      timer.unref()
    })

    const doClose = async (): Promise<'done'> => {
      // 1. Await any in-flight flush from triggerFlush()
      await buffer.awaitInflight()

      // 2. Drain remaining buffer and send final batch
      const remaining = buffer.drain()
      buffer.destroy()

      if (remaining.length > 0) {
        await this.sendBatch(remaining)
      }
      return 'done'
    }

    const result = await Promise.race([doClose().catch(() => 'error' as const), timeout])
    if (result === 'timeout') {
      this.closeController.abort()
      buffer.destroy()
    }
  }

  /**
   * Winston calls close() synchronously — we trigger the async close
   * and let it complete in the background.
   */
  close(): void {
    this.closeAsync().catch((err) => {
      console.warn('[LogWeave] error during close:', err)
    })
  }
}
