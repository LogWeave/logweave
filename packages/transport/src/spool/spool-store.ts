/**
 * Durable spool seam (#269) — Seam A of the no-loss archive epic (#265).
 *
 * Replaces the at-most-once in-memory buffer with a queue the network pump
 * (#270) drains: events are inserted, the pump peeks the oldest, sends them,
 * and deletes them only once the API has acked. A durable backend persists the
 * spool to disk so an insert survives a crash before the send; the in-memory
 * backend keeps the existing best-effort behaviour for `durable: false`.
 *
 * The `event_id` (UUIDv7) is assigned here, at insert — it is the source dedup
 * key the API collapses on (ReplacingMergeTree, #267) and is embedded in the
 * stored event so a replay after a crash carries the same id.
 */
import type { LogEvent } from '../types.js'

/** A spooled event: the send-ready payload plus its identity and age. */
export interface SpooledEvent {
  /** UUIDv7 assigned at insert — the dedup key, also embedded in `event`. */
  readonly eventId: string
  /** The log event with `event_id` set, ready to serialize and send. */
  readonly event: LogEvent
  /** Epoch milliseconds when the event was enqueued. */
  readonly enqueuedAt: number
}

/**
 * A queue of pending log events. Implementations are either durable
 * (crash-safe, fsync-on-insert) or in-memory (best-effort).
 */
export interface SpoolStore {
  /**
   * Persist an event, assigning and returning its UUIDv7 `event_id`. A durable
   * backend returns only after the write has fsynced, so the event survives a
   * crash that happens before it is sent.
   */
  insert(event: LogEvent): string
  /** The oldest up-to-`n` spooled events, in enqueue order, for the pump to send. */
  peekOldest(n: number): SpooledEvent[]
  /** Remove spooled events by `event_id` — called after the API acks the send. */
  delete(eventIds: readonly string[]): void
  /** Number of events currently spooled. */
  count(): number
  /** Release any held resources (file handles, etc.). */
  close(): void
}
