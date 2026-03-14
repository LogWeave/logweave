/**
 * LogWeave Winston Transport.
 *
 * Extends winston-transport to buffer log events and send them in batches
 * to the LogWeave API. Never blocks the application logger.
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
import type { BatchPayload, LogEvent, TransportOptions } from './types.js'

const DEFAULT_ENDPOINT = 'http://localhost:3000/v1/ingest/batch'
const DEFAULT_BUFFER_SIZE = 1000
const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 2000
const DEFAULT_MAX_RETRIES = 3
const CLOSE_TIMEOUT_MS = 2000

/** Winston internal symbol for the raw level string */
const LEVEL_SYMBOL = Symbol.for('level')
/** Winston internal symbol for the splat args */
const SPLAT_SYMBOL = Symbol.for('splat')

/** Keys to exclude when extracting metadata from Winston info */
const EXCLUDED_KEYS = new Set(['level', 'message', 'timestamp'])

let productionWarningShown = false

export class LogWeaveTransport extends TransportStream {
  private readonly apiKey: string
  private readonly service: string
  private readonly environment: string | undefined
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchFn: typeof globalThis.fetch
  private readonly buffer: BufferManager
  private closeController: AbortController | null = null

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

    this.buffer = new BufferManager({
      bufferSize: opts.bufferSize ?? DEFAULT_BUFFER_SIZE,
      flushIntervalMs: opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      onFlush: (events) => this.sendBatch(events),
    })
  }

  /**
   * Called by Winston for each log entry.
   * Pushes the event to the buffer and calls callback() synchronously.
   * NEVER blocks the application logger.
   */
  log(info: Record<string | symbol, unknown>, callback: () => void): void {
    const event = this.extractEvent(info)
    this.buffer.push(event)
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

    await retryFetch(
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
  }

  /**
   * Flush remaining events and shut down.
   * Times out after 2s if the flush hangs.
   * Aborts any inflight retries via AbortController.
   */
  async closeAsync(): Promise<void> {
    this.closeController = new AbortController()

    const remaining = this.buffer.drain()
    this.buffer.destroy()

    if (remaining.length === 0) {
      return
    }

    const flushPromise = this.sendBatch(remaining)
    const timeoutPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.closeController?.abort()
        resolve()
      }, CLOSE_TIMEOUT_MS)
      timer.unref()
    })

    await Promise.race([flushPromise, timeoutPromise])
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
