/**
 * Backpressure coordinator (#271) — Seam A of the no-loss archive epic (#265).
 *
 * The durable spool can't grow without bound: if the downstream (S3/Vector) is
 * down, the pump (#270) can't drain and the spool fills disk. This wraps a
 * SpoolStore with a cap and decides what happens when a producer enqueues at
 * the cap. The guarantee is NEVER a silent drop.
 *
 * Policy (resolves the epic's open question #2): durable mode is opt-in, so a
 * user who enabled it chose durability over the transport's normal
 * never-block-the-logger behaviour. At the cap we:
 *   1. fire onBackpressure(stats) so the app can react,
 *   2. bounded-block the enqueue up to `blockMs` (the SLO), polling for the
 *      pump to drain space, then
 *   3. fail OPEN if still full: drop the event with a loud onDrop/console.error
 *      (never silent) so the app stays available rather than stalling forever.
 *
 * `enqueue` is async because the bounded block is — the caller (a durable-mode
 * log path) applies backpressure by awaiting it before acking the write.
 */
import type { LogEvent } from '../types.js'
import type { SpoolStore } from './spool-store.js'

export interface BackpressureStats {
  /** Events currently in the spool. */
  readonly spooled: number
  /** The cap that triggered backpressure. */
  readonly cap: number
}

export type EnqueueResult = 'spooled' | 'dropped'

export interface SpoolWriterOptions {
  readonly spool: SpoolStore
  /** Max spooled events before backpressure kicks in (disk-cap proxy). */
  readonly maxSpooledEvents: number
  /**
   * SLO: longest an enqueue may block waiting for drainage, ms. Default: 5000.
   * Soft bound — the poll loop rechecks on a `pollMs` cadence, so the actual
   * worst-case block is up to `blockMs + pollMs`.
   */
  readonly blockMs?: number
  /** How often to recheck for drained space while blocked, ms. Default: 50. */
  readonly pollMs?: number
  /** Fired when an enqueue hits the cap and starts blocking. */
  readonly onBackpressure?: (stats: BackpressureStats) => void
  /** Fired when an event is dropped after the SLO (fail-open). Never silent. */
  readonly onDrop?: (events: readonly LogEvent[], error: Error) => void
  /** Injectable sleep (testing). Default: setTimeout. */
  readonly sleepFn?: (ms: number) => Promise<void>
  /** Injectable clock (testing). Default: Date.now. */
  readonly nowFn?: () => number
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

export class SpoolWriter {
  private readonly spool: SpoolStore
  private readonly cap: number
  private readonly blockMs: number
  private readonly pollMs: number
  private readonly onBackpressure: ((stats: BackpressureStats) => void) | undefined
  private readonly onDrop: ((events: readonly LogEvent[], error: Error) => void) | undefined
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(options: SpoolWriterOptions) {
    this.spool = options.spool
    this.cap = options.maxSpooledEvents
    this.blockMs = options.blockMs ?? 5000
    this.pollMs = options.pollMs ?? 50
    this.onBackpressure = options.onBackpressure
    this.onDrop = options.onDrop
    this.sleepFn = options.sleepFn ?? defaultSleep
    this.now = options.nowFn ?? Date.now
  }

  /**
   * Enqueue an event, applying backpressure at the cap. Returns 'spooled' when
   * persisted (immediately, or after the pump drained within the SLO), or
   * 'dropped' when the SLO elapsed while still full (reported loudly).
   */
  async enqueue(event: LogEvent): Promise<EnqueueResult> {
    if (this.spool.count() < this.cap) {
      this.spool.insert(event)
      return 'spooled'
    }

    // At the cap — signal and bounded-block waiting for the pump to drain.
    this.fireBackpressure()
    const deadline = this.now() + this.blockMs
    while (this.now() < deadline) {
      await this.sleepFn(this.pollMs)
      if (this.spool.count() < this.cap) {
        this.spool.insert(event)
        return 'spooled'
      }
    }

    // SLO exceeded — fail open: drop, but loudly.
    this.reportDrop(
      event,
      `[LogWeave] backpressure: spool full (cap ${this.cap}) and did not drain within ` +
        `${this.blockMs}ms — dropping event (downstream slow or unreachable)`,
    )
    return 'dropped'
  }

  private fireBackpressure(): void {
    if (!this.onBackpressure) return
    try {
      this.onBackpressure({ spooled: this.spool.count(), cap: this.cap })
    } catch {
      // callbacks must never throw back into the logger
    }
  }

  private reportDrop(event: LogEvent, message: string): void {
    const error = new Error(message)
    if (!this.onDrop) {
      console.error(message)
      return
    }
    try {
      this.onDrop([event], error)
    } catch {
      // onDrop must never throw back into the logger — and if it does, still
      // surface the drop so a buggy handler can't make a loss invisible.
      console.error(message)
    }
  }
}
