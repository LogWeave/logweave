import type pino from 'pino'
import type { S3Adapter } from '../connectors/s3-adapter.js'
import type { S3ConnectorConfig } from '../connectors/types.js'
import { type IngestDependencies, ingestBatch } from '../pipeline/ingest.js'
import type { ArchiveNotifyQueue, NotifyQueueItem } from './notify-queue.js'

export interface ArchiveNotifyConsumerDeps {
  queue: ArchiveNotifyQueue
  /** The customer's archive bucket config (read side). */
  archiveConfig: S3ConnectorConfig
  /** Reused ingest pipeline — clusters + inserts log_metadata with source_ref. */
  ingest: IngestDependencies
  adapter: S3Adapter
  logger: pino.Logger
}

export interface ArchiveNotifyConsumerConfig {
  /** Poll interval for the background loop (ms). */
  intervalMs?: number
  /** Max queue items processed per tick. */
  batchSize?: number
  /** Re-tries before dropping an object (reconciliation #279 is the backstop). */
  maxAttempts?: number
}

/**
 * Async Drain3 consumer of landed objects (epic #265, seam C, #277).
 *
 * Drains the in-process notify queue (#276): for each `source_ref` it GETs the
 * object from the archive bucket, parses the NDJSON, and runs it through the
 * existing ingest pipeline (`ingestBatch`) — which clusters via the clusterer
 * and INSERTs `log_metadata` rows carrying the `source_ref` and the real
 * `template_id`. `event_id` on each row makes the insert idempotent under
 * ReplacingMergeTree, so a replayed notify collapses to one row.
 *
 * Failures (S3 GET, clusterer timeout) retry a few times, then drop — the
 * reconciliation sweep (#279) backfills anything permanently dropped.
 */
export class ArchiveNotifyConsumer {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly attempts = new Map<string, number>()
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly maxAttempts: number

  constructor(
    private readonly deps: ArchiveNotifyConsumerDeps,
    config: ArchiveNotifyConsumerConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 1000
    this.batchSize = config.batchSize ?? 10
    this.maxAttempts = config.maxAttempts ?? 3
  }

  /** Start the background drain loop. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.drainOnce()
    }, this.intervalMs)
    this.timer.unref()
  }

  /** Stop the loop and wait briefly for an in-flight drain to finish. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const deadline = Date.now() + 5_000
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /**
   * Process up to `batchSize` queued items once; returns how many succeeded.
   * Mutex-guarded so the interval can't overlap itself. Exposed for tests.
   */
  async drainOnce(): Promise<number> {
    if (this.running) return 0
    // Skip while the clusterer circuit is open (like RecoverySweep): leave items
    // queued rather than eagerly producing template_id=0 rows the reconciliation
    // sweep (#279) would have to re-cluster. Reconciliation backfills if the
    // queue overflows or the process restarts during a long outage.
    if (this.deps.ingest.clusterClient.isCircuitOpen) return 0
    this.running = true
    let processed = 0
    try {
      for (const item of this.deps.queue.dequeue(this.batchSize)) {
        if (await this.processItem(item)) processed++
      }
    } finally {
      this.running = false
    }
    return processed
  }

  private async processItem(item: NotifyQueueItem): Promise<boolean> {
    try {
      const events = await this.deps.adapter.fetchObjectEvents(
        this.deps.archiveConfig,
        item.sourceRef,
      )
      if (events.length > 0) {
        await ingestBatch(this.deps.ingest, item.tenantId, events, {
          sourceType: 's3',
          sourceRef: item.sourceRef,
        })
      }
      this.attempts.delete(item.sourceRef)
      return true
    } catch (err) {
      const attempt = (this.attempts.get(item.sourceRef) ?? 0) + 1
      if (attempt < this.maxAttempts) {
        this.attempts.set(item.sourceRef, attempt)
        this.deps.queue.enqueue(item) // retry on a later tick
        this.deps.logger.warn(
          { err, sourceRef: item.sourceRef, attempt },
          'Archive notify consume failed; will retry',
        )
      } else {
        this.attempts.delete(item.sourceRef)
        this.deps.logger.error(
          { err, sourceRef: item.sourceRef, attempts: attempt },
          'Archive notify consume failed permanently; dropping (reconciliation #279 backfills)',
        )
      }
      return false
    }
  }
}
