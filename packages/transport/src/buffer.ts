/**
 * Double-buffering manager for LogWeave transport.
 *
 * Events are pushed into an active buffer. When the buffer reaches capacity
 * or the flush timer fires, the active buffer is swapped with a fresh one
 * and the full buffer is passed to the onFlush callback.
 *
 * This swap is synchronous (single-threaded JS), so events pushed during
 * an async flush go safely into the new active buffer.
 *
 * The flush timer uses setTimeout().unref() so it never prevents process exit.
 */
import type { LogEvent } from './types.js'

/** Default hard cap on retained events when a flush is stuck (slow/down API). */
export const DEFAULT_MAX_RETAINED_EVENTS = 50_000

export interface BufferManagerOptions {
  /** Max events before triggering a flush. Default: 1000 */
  readonly bufferSize: number
  /** Flush interval in milliseconds. Default: 5000 */
  readonly flushIntervalMs: number
  /**
   * Hard cap on retained (buffered-but-not-yet-sent) events. When the API is
   * slow or down a flush stays in-flight and new events pile up in the active
   * buffer; without this cap the buffer grows until the host app OOMs. Beyond
   * the cap the oldest events are dropped. Default: 50000.
   */
  readonly maxRetainedEvents?: number
  /** Callback invoked with the batch of events to send */
  readonly onFlush: (events: readonly LogEvent[]) => Promise<void>
  /** Called with events dropped because the retention cap was exceeded. */
  readonly onDrop?: (events: readonly LogEvent[], error: Error) => void
}

export class BufferManager {
  private active: LogEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private inflightFlush: Promise<void> | null = null
  private droppedCount = 0

  private readonly bufferSize: number
  private readonly flushIntervalMs: number
  private readonly maxRetainedEvents: number
  private readonly onFlush: (events: readonly LogEvent[]) => Promise<void>
  private readonly onDrop: ((events: readonly LogEvent[], error: Error) => void) | undefined

  constructor(options: BufferManagerOptions) {
    this.bufferSize = options.bufferSize
    this.flushIntervalMs = options.flushIntervalMs
    this.maxRetainedEvents = options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS
    this.onFlush = options.onFlush
    this.onDrop = options.onDrop
    this.resetTimer()
  }

  /**
   * Push an event into the active buffer.
   * If the buffer reaches capacity, triggers an immediate flush. If the
   * retention cap is exceeded (flush stuck on a slow/down API), the oldest
   * events are dropped to bound memory.
   */
  push(event: LogEvent): void {
    if (this.destroyed) return
    this.active.push(event)

    if (this.active.length > this.maxRetainedEvents) {
      const overflow = this.active.length - this.maxRetainedEvents
      const dropped = this.active.splice(0, overflow)
      this.droppedCount += dropped.length
      if (this.onDrop) {
        try {
          this.onDrop(
            dropped,
            new Error(
              `[LogWeave] dropped ${dropped.length} oldest buffered event(s): retention cap of ${this.maxRetainedEvents} reached (API slow or unreachable)`,
            ),
          )
        } catch {
          // onDrop must never throw back into the logger
        }
      }
    }

    if (this.active.length >= this.bufferSize) {
      this.triggerFlush()
    }
  }

  /** Number of events currently retained in the active buffer. */
  size(): number {
    return this.active.length
  }

  /** Total events dropped due to the retention cap over this buffer's lifetime. */
  getDroppedCount(): number {
    return this.droppedCount
  }

  /**
   * Swap the active buffer and flush the old one.
   * Capped at 1 concurrent flush — if one is in-flight, this call is skipped
   * and events stay in the active buffer for the next timer tick.
   */
  triggerFlush(): void {
    if (this.active.length === 0) return
    if (this.inflightFlush !== null) return

    // Synchronous swap — events pushed during async flush go to the new array
    const batch = this.active
    this.active = []
    this.resetTimer()

    this.inflightFlush = this.onFlush(batch)
      .catch((err) => {
        console.warn('[LogWeave] flush error:', err)
      })
      .finally(() => {
        this.inflightFlush = null
      })
  }

  /**
   * Returns a promise that resolves when any in-flight flush completes.
   * Resolves immediately if no flush is in-flight.
   */
  awaitInflight(): Promise<void> {
    return this.inflightFlush ?? Promise.resolve()
  }

  /**
   * Drain all remaining events without flushing.
   * Used by close() to get the final batch.
   */
  drain(): LogEvent[] {
    const events = this.active
    this.active = []
    return events
  }

  /**
   * Stop the timer and mark the buffer as destroyed.
   * No more events will be accepted after this call.
   */
  destroy(): void {
    this.destroyed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private resetTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.triggerFlush()
    }, this.flushIntervalMs)
    this.timer.unref()
  }
}
