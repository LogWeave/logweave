/**
 * Engine seam contracts for the no-loss durable archive pipeline (epic #265).
 *
 * The pipeline is three decoupled engines joined by *physical seams* — an S3
 * object, an HTTP call — not shared code:
 *
 *   SDK ──ingest wire──▶ INGEST+ARCHIVE engine ──S3 object──▶ TRANSFORM engine
 *                              │                                    │
 *                              └──────── notify envelope ───────────┘
 *
 * This file is the single place those seam shapes are defined, so engines can
 * be built, tested, and swapped independently. It defines contracts only — no
 * real S3, Vector, or SDK wiring lives here (those are later issues in #265).
 *
 * Durability axiom: a log is "safe" only once its raw bytes are durably in the
 * customer's own S3. Every ack in the chain is gated on a durable write.
 */

// ---------------------------------------------------------------------------
// Shared identity
// ---------------------------------------------------------------------------

/**
 * HTTP header carrying the batch-level idempotency key on the ingest wire.
 * A replay of the same batch (same key) must not produce duplicate archived
 * objects or duplicate metadata rows. Per-event dedupe is handled separately
 * by {@link WireLogEvent.event_id} + `ReplacingMergeTree(event_id)` (issue #267).
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'

// ---------------------------------------------------------------------------
// Seam 1 — ArchiveSink (the system of record)
// ---------------------------------------------------------------------------

/**
 * The archive seam: write raw log bytes durably to the customer's own object
 * store. This is the **system of record** — ClickHouse metadata and Drain3
 * clustering are downstream consumers of what lands here, never gatekeepers.
 *
 * Contract:
 * - `put` resolves **only** once the bytes are durably stored (e.g. S3 has
 *   acknowledged the object). A resolved promise is the durability guarantee
 *   the ingest 2xx is gated on; a rejection means "not safe — do not ack".
 * - `objectKey` **is** the `source_ref` recorded in metadata. The same key
 *   must address the same bytes for later drill-down (`raw_logs` reads).
 * - Implementations should be idempotent on `objectKey`: writing the same key
 *   twice (a replay) must leave exactly one object with those bytes.
 */
export interface ArchiveSink {
  /**
   * Durably store `bytes` under `objectKey`. Resolves on durable success;
   * rejects if the write could not be confirmed (caller must not ack).
   *
   * @param objectKey Storage key that becomes the `source_ref` pointer.
   * @param bytes Raw payload (typically gzip-compressed NDJSON).
   */
  put(objectKey: string, bytes: Uint8Array): Promise<void>
}

// ---------------------------------------------------------------------------
// Seam 2 — Ingest wire contract (SDK → ingest+archive engine)
// ---------------------------------------------------------------------------

/**
 * One log event as it travels on the ingest wire.
 *
 * The wire framing is **NDJSON** (one JSON object per line) so the engine can
 * stream-archive without buffering the whole batch, and a batch carries the
 * {@link IDEMPOTENCY_KEY_HEADER} header.
 *
 * Critical-path contract: an HTTP **2xx means the raw bytes are durably
 * archived** in the customer's S3 — not merely received in memory. Anything
 * that can lose data (clustering, metadata insert) happens *after* the ack and
 * must never gate it.
 */
export interface WireLogEvent {
  /**
   * UUIDv7 assigned **at the source**: the SDK assigns it at spool-insert;
   * non-SDK ingest routes generate a fallback UUIDv7. Stored as a column
   * separate from the server-generated `id`, and is the dedupe key for
   * `ReplacingMergeTree(event_id)` (issue #267) so a replay collapses to one
   * row.
   */
  event_id: string
  /** Event timestamp (ISO 8601). Omitted events are stamped at ingest. */
  timestamp?: string
  /** Arbitrary structured log fields (message, level, service, …). */
  [key: string]: unknown
}

/**
 * A decoded ingest batch: the events plus the batch-level idempotency key
 * lifted from the {@link IDEMPOTENCY_KEY_HEADER} header. This is the in-process
 * shape after NDJSON framing is parsed; the wire itself is NDJSON, not this.
 */
export interface IngestWireBatch {
  /** Batch-level idempotency key (from the header). */
  idempotencyKey: string
  /** The events in this batch, in wire order. */
  events: WireLogEvent[]
}

// ---------------------------------------------------------------------------
// Seam 3 — Notify contract (archive engine → transform engine)
// ---------------------------------------------------------------------------

/**
 * "Raw landed at `source_ref`" notification — a **keys-only** pointer envelope
 * sent after an object is durably archived, so the transform engine (async
 * Drain3 consumer) knows there is a new object to fetch and process.
 *
 * Keys only: this envelope carries pointers and counts, **never raw log
 * bytes**. The transform engine reads the actual events back from the archived
 * object addressed by `source_ref`. The notify hop is allowed to be lossy —
 * S3 remains the source of truth, and a missed notify is recoverable by a
 * reconciliation sweep (issue #279).
 */
export interface NotifyEnvelope {
  /** Tenant that owns the archived object. */
  tenant_id: string
  /**
   * Storage key of the durably-archived object — the same value used as
   * {@link ArchiveSink.put}'s `objectKey` and recorded as `source_ref`.
   */
  source_ref: string
  /** Service the batch was attributed to, when known at archive time. */
  service?: string
  /** Number of events in the archived object. */
  event_count: number
  /** Size of the archived object in bytes (compressed). */
  byte_size: number
  /** When the object became durable in the archive (ISO 8601). */
  landed_at: string
}
