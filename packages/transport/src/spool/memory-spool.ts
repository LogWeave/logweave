/**
 * In-memory SpoolStore (#269) — the `durable: false` backend. Best-effort: the
 * queue lives only in process memory, so a crash loses unsent events. Preserves
 * the existing buffer's retention-cap behaviour (drop oldest when the API is
 * slow/down) so memory is bounded and the host app can't OOM.
 */
import type { LogEvent } from '../types.js'
import { uuidv7 } from '../uuid.js'
import type { SpooledEvent, SpoolStore } from './spool-store.js'

/** Default hard cap on retained events when sends are stuck (slow/down API). */
export const DEFAULT_MAX_RETAINED_EVENTS = 50_000

export interface MemorySpoolOptions {
  /**
   * Hard cap on spooled-but-unsent events. Beyond it the oldest events are
   * dropped (and `onDrop` fires) so the SDK can never OOM the host. Default: 50000.
   */
  readonly maxRetainedEvents?: number
  /** Called with events dropped because the retention cap was exceeded. */
  readonly onDrop?: (events: readonly LogEvent[], error: Error) => void
}

export class MemorySpoolStore implements SpoolStore {
  private events: SpooledEvent[] = []
  private readonly maxRetainedEvents: number
  private readonly lowWaterMark: number
  private readonly onDrop: ((events: readonly LogEvent[], error: Error) => void) | undefined

  constructor(options: MemorySpoolOptions = {}) {
    this.maxRetainedEvents = options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS
    // Evict down to a low-water mark in one shot rather than one event per
    // insert — keeps the same hard bound while amortizing the O(n) shift.
    this.lowWaterMark = Math.max(1, Math.floor(this.maxRetainedEvents * 0.9))
    this.onDrop = options.onDrop
  }

  insert(event: LogEvent): string {
    const eventId = uuidv7()
    this.events.push({
      eventId,
      event: { ...event, event_id: eventId },
      enqueuedAt: Date.now(),
    })

    if (this.events.length > this.maxRetainedEvents) {
      const dropped = this.events.splice(0, this.events.length - this.lowWaterMark)
      if (this.onDrop) {
        try {
          this.onDrop(
            dropped.map((d) => d.event),
            new Error(
              `[LogWeave] dropped ${dropped.length} oldest spooled event(s): retention cap of ${this.maxRetainedEvents} reached (API slow or unreachable)`,
            ),
          )
        } catch {
          // onDrop must never throw back into the logger
        }
      }
    }

    return eventId
  }

  peekOldest(n: number): SpooledEvent[] {
    return this.events.slice(0, Math.max(0, n))
  }

  delete(eventIds: readonly string[]): void {
    if (eventIds.length === 0) return
    const remove = new Set(eventIds)
    this.events = this.events.filter((e) => !remove.has(e.eventId))
  }

  count(): number {
    return this.events.length
  }

  close(): void {
    this.events = []
  }
}
