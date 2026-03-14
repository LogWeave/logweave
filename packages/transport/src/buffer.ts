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

export interface BufferManagerOptions {
  /** Max events before triggering a flush. Default: 1000 */
  readonly bufferSize: number
  /** Flush interval in milliseconds. Default: 5000 */
  readonly flushIntervalMs: number
  /** Callback invoked with the batch of events to send */
  readonly onFlush: (events: readonly LogEvent[]) => Promise<void>
}

export class BufferManager {
  private active: LogEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  private readonly bufferSize: number
  private readonly flushIntervalMs: number
  private readonly onFlush: (events: readonly LogEvent[]) => Promise<void>

  constructor(options: BufferManagerOptions) {
    this.bufferSize = options.bufferSize
    this.flushIntervalMs = options.flushIntervalMs
    this.onFlush = options.onFlush
    this.resetTimer()
  }

  /**
   * Push an event into the active buffer.
   * If the buffer reaches capacity, triggers an immediate flush.
   */
  push(event: LogEvent): void {
    if (this.destroyed) return
    this.active.push(event)

    if (this.active.length >= this.bufferSize) {
      this.triggerFlush()
    }
  }

  /**
   * Swap the active buffer and flush the old one.
   * Fire-and-forget: errors are caught internally.
   */
  triggerFlush(): void {
    if (this.active.length === 0) return

    // Synchronous swap — events pushed during async flush go to the new array
    const batch = this.active
    this.active = []
    this.resetTimer()

    // Fire-and-forget — never let flush errors propagate
    this.onFlush(batch).catch((err) => {
      console.warn('[LogWeave] flush error:', err)
    })
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
