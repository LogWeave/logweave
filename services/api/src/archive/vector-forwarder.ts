/**
 * Vector archive forwarder — Seam A producer side of the no-loss epic (#265).
 *
 * The public ingest routes call this instead of clustering synchronously: a
 * validated batch is forwarded to the Vector archive engine as NDJSON, Vector
 * gzips it into the customer's own S3, and (with the memory-buffer ack gate,
 * #274) withholds its 2xx until the S3 PUT lands. Drain3 clustering then happens
 * off the hot path in the async consumer (#277), which re-ingests the landed
 * object with the real template_id (event_id dedup via ReplacingMergeTree).
 *
 * Two server-trusted invariants are stamped here, never taken from the client:
 *   - `tenant_id` — from the authenticated API key, overriding any client value
 *     (Vector's key_prefix partitions on it; a client-supplied tenant_id would
 *     be a cross-tenant write). Closes the #275 ingest-trust note.
 *   - `event_id` — the SDK-assigned UUIDv7 when present, else a fallback, so the
 *     consumer's insert dedups a replayed batch.
 *
 * No-loss contract: resolve ONLY on Vector's gated 2xx. Any non-2xx / network /
 * timeout throws, so the route returns 5xx and the durable pump retains the
 * batch in its spool and retries — events are never acked before they are in S3.
 */
import { ensureEventId } from '../pipeline/idempotency.js'

/** Vector withholds the gated 200 up to prod `batch.timeout_secs` (30s); give margin. */
const DEFAULT_TIMEOUT_MS = 35_000

export interface VectorForwarderConfig {
  /** Vector archive endpoint, e.g. http://vector:8686/v1/archive */
  readonly url: string
  /** Per-POST timeout, ms. Default 35000. */
  readonly timeoutMs?: number
  /** Injectable fetch (testing). Default: globalThis.fetch */
  readonly fetchFn?: typeof globalThis.fetch
}

export interface ForwardOptions {
  /** Authenticated tenant — stamped onto every event, overriding client input. */
  readonly tenantId: string
  /** Batch-level service default; a per-event `service` wins. */
  readonly service?: string
  /** Batch-level environment default; a per-event `environment` wins. */
  readonly environment?: string
}

/** Thrown when the archive forward did not durably land (non-2xx / network / timeout). */
export class VectorForwardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VectorForwardError'
  }
}

/**
 * Forward a validated batch to Vector as NDJSON. Resolves on the S3-durable
 * gated 2xx; throws {@link VectorForwardError} otherwise.
 */
export async function forwardToVector(
  config: VectorForwarderConfig,
  events: readonly unknown[],
  options: ForwardOptions,
): Promise<void> {
  const fetchFn = config.fetchFn ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const ndjson = events.map((event) => JSON.stringify(enrich(event, options))).join('\n')

  let res: Response
  try {
    res = await fetchFn(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: ndjson,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // Network error, timeout, or abort — transient; the pump retries.
    throw new VectorForwardError(`archive forward failed: ${(err as Error).message}`)
  }
  if (!res.ok) {
    throw new VectorForwardError(`archive forward rejected: HTTP ${res.status}`)
  }
}

/** Stamp server-trusted tenant_id + event_id and fill service/environment defaults. */
function enrich(event: unknown, options: ForwardOptions): Record<string, unknown> {
  const base =
    typeof event === 'object' && event !== null
      ? (event as Record<string, unknown>)
      : { message: event }
  return {
    ...base,
    event_id: ensureEventId(base),
    tenant_id: options.tenantId,
    service: base.service ?? options.service,
    environment: base.environment ?? options.environment,
  }
}
