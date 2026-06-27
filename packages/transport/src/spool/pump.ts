/**
 * Durable delivery pump (#270) — Seam A of the no-loss archive epic (#265).
 *
 * A background loop that drains a SpoolStore: peek the oldest events, POST them
 * as a batch with an Idempotency-Key, and apply the outcome:
 *   - 2xx          → delete from the spool (durably delivered)
 *   - 5xx/network  → retain + retry with exponential backoff (transient)
 *   - other 4xx    → report via onDrop + delete (unrecoverable; don't block the queue)
 *
 * The spool is the retry buffer: a transient failure leaves events in place and
 * the next tick re-sends them, so delivery is at-least-once across crashes. The
 * server collapses duplicates on event_id (ReplacingMergeTree, #267) and the
 * Idempotency-Key short-circuits a replayed batch (#268).
 *
 * CRITICAL no-loss assumption: the 2xx this deletes on MUST be the
 * S3-durable-gated 200 (P2, #274). If the ingest endpoint acks on buffer-accept
 * rather than on the archive being durable, this deletes prematurely and breaks
 * the no-loss guarantee. Today's /v1/ingest/batch is synchronous-to-ClickHouse;
 * the S3 gating lands with the Vector archive engine.
 *
 * Out of scope (#271): backpressure / disk-cap behaviour on insert.
 */
import { createHash } from 'node:crypto'
import type { LogEvent } from '../types.js'
import type { SpooledEvent, SpoolStore } from './spool-store.js'

type Outcome = 'ok' | 'retry' | 'unrecoverable'

export interface PumpOptions {
  readonly spool: SpoolStore
  /** Ingest endpoint, e.g. http://localhost:3000/v1/ingest/batch */
  readonly endpoint: string
  readonly apiKey: string
  readonly service: string
  readonly environment?: string
  /** Max events per POST (peekOldest size). Default: 1000 */
  readonly batchSize?: number
  /** Idle poll interval when the spool is empty, ms. Default: 1000 */
  readonly pollIntervalMs?: number
  /** Initial retry backoff after a transient failure, ms. Default: 500 */
  readonly initialBackoffMs?: number
  /** Cap on the exponential retry backoff, ms. Default: 30000 */
  readonly maxBackoffMs?: number
  /** Per-POST timeout, ms. Default: 2000 */
  readonly timeoutMs?: number
  /** Injectable fetch (testing). Default: globalThis.fetch */
  readonly fetchFn?: typeof globalThis.fetch
  /** Injectable sleep (testing). Default: abortable setTimeout. */
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Called with events dropped on an unrecoverable (4xx) response. */
  readonly onDrop?: (events: readonly LogEvent[], error: Error) => void
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      // Remove the listener on the normal path — {once:true} only self-removes
      // after firing, so without this an idle pump's long-lived signal would
      // accumulate one listener per poll/backoff tick (a real leak).
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class Pump {
  private readonly spool: SpoolStore
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly service: string
  private readonly environment: string | undefined
  private readonly batchSize: number
  private readonly pollIntervalMs: number
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly timeoutMs: number
  private readonly fetchFn: typeof globalThis.fetch
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly onDrop: ((events: readonly LogEvent[], error: Error) => void) | undefined

  private running = false
  private loop: Promise<void> | null = null
  private abort: AbortController | null = null
  private backoffMs = 0

  constructor(options: PumpOptions) {
    this.spool = options.spool
    this.endpoint = options.endpoint
    this.apiKey = options.apiKey
    this.service = options.service
    this.environment = options.environment
    this.batchSize = options.batchSize ?? 1000
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
    this.initialBackoffMs = options.initialBackoffMs ?? 500
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.timeoutMs = options.timeoutMs ?? 2000
    this.fetchFn = options.fetchFn ?? globalThis.fetch
    this.sleepFn = options.sleepFn ?? defaultSleep
    this.onDrop = options.onDrop
  }

  /** Begin draining in the background. Idempotent. */
  start(): void {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    this.loop = this.run()
  }

  /** Stop draining: abort any in-flight POST/sleep and await the loop to settle. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort?.abort()
    await this.loop
    this.loop = null
    this.abort = null
  }

  private async run(): Promise<void> {
    while (this.running) {
      const batch = this.spool.peekOldest(this.batchSize)
      if (batch.length === 0) {
        await this.sleepFn(this.pollIntervalMs, this.abort?.signal)
        continue
      }

      const outcome = await this.postBatch(batch)
      if (!this.running) break

      if (outcome === 'ok') {
        this.spool.delete(batch.map((e) => e.eventId))
        this.backoffMs = 0
        continue // drain the next batch immediately
      }

      if (outcome === 'unrecoverable') {
        this.reportDrop(batch)
        this.spool.delete(batch.map((e) => e.eventId))
        this.backoffMs = 0
        continue
      }

      // transient: retain the batch and back off before retrying it. Full
      // jitter (sleep a random fraction of the cap) avoids synchronized retries
      // across many clients, matching retry.ts.
      this.backoffMs = this.backoffMs
        ? Math.min(this.backoffMs * 2, this.maxBackoffMs)
        : this.initialBackoffMs
      await this.sleepFn(Math.random() * this.backoffMs, this.abort?.signal)
    }
  }

  private async postBatch(batch: readonly SpooledEvent[]): Promise<Outcome> {
    const events = batch.map((e) => e.event)
    const body = JSON.stringify({ service: this.service, environment: this.environment, events })
    const idempotencyKey = batchKey(batch.map((e) => e.eventId))

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = this.abort?.signal ? AbortSignal.any([timeout, this.abort.signal]) : timeout

    try {
      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Idempotency-Key': idempotencyKey,
        },
        body,
        signal,
      })
      if (res.ok) return 'ok'
      // 429 (rate limit) and 5xx are transient; other 4xx are unrecoverable.
      if (res.status === 429 || res.status >= 500) return 'retry'
      if (res.status >= 400) return 'unrecoverable'
      return 'retry' // unexpected non-2xx — be conservative, keep the data
    } catch {
      // network error / timeout / abort — transient
      return 'retry'
    }
  }

  private reportDrop(batch: readonly SpooledEvent[]): void {
    const error = new Error(
      `[LogWeave] dropped ${batch.length} event(s): ingest rejected the batch (4xx, unrecoverable)`,
    )
    if (!this.onDrop) {
      // Fail loudly: never drop data silently, even when no handler is wired.
      console.error(error.message)
      return
    }
    try {
      this.onDrop(
        batch.map((e) => e.event),
        error,
      )
    } catch {
      // onDrop must never throw back into the pump
    }
  }
}

/** Stable, order-independent batch key from the events' UUIDv7 event_ids. */
export function batchKey(eventIds: readonly string[]): string {
  return createHash('sha256')
    .update([...eventIds].sort().join('\n'))
    .digest('hex')
}
