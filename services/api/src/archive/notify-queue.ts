/**
 * In-process queue of "raw landed at source_ref" notifications (epic #265,
 * seam C). The notify endpoint (#276) enqueues; the async Drain3 consumer
 * (#277) drains, GETs each object, clusters, and writes log_metadata.
 *
 * Best-effort by design: the notify hop is allowed to be lossy — S3 is the
 * source of truth and the reconciliation sweep (#279) backfills anything missed
 * (a process restart that empties this queue, or a drop when full). So an
 * in-process queue is the right amount of machinery; it does NOT need to be
 * durable. It is bounded so a clusterer stall can't grow it without limit.
 */

export interface NotifyQueueItem {
  /** Tenant that owns the archived object. */
  tenantId: string
  /** Storage key of the durably-archived object (becomes/equals source_ref). */
  sourceRef: string
  /** Service the batch was attributed to, when known at archive time. */
  service?: string
}

export class ArchiveNotifyQueue {
  private readonly pending: NotifyQueueItem[] = []
  /** source_refs currently pending — makes enqueue idempotent (#276 DoD). */
  private readonly pendingRefs = new Set<string>()
  private droppedWhenFull = 0

  constructor(private readonly maxSize = 10_000) {}

  /**
   * Enqueue an item unless its `sourceRef` is already pending (idempotent) or
   * the queue is full (best-effort drop — reconciliation backfills). Returns
   * true only when the item was newly enqueued.
   */
  enqueue(item: NotifyQueueItem): boolean {
    if (this.pendingRefs.has(item.sourceRef)) return false
    if (this.pending.length >= this.maxSize) {
      this.droppedWhenFull++
      return false
    }
    this.pending.push(item)
    this.pendingRefs.add(item.sourceRef)
    return true
  }

  /** Remove and return up to `n` items, oldest first (the consumer, #277). */
  dequeue(n = 1): NotifyQueueItem[] {
    const taken = this.pending.splice(0, Math.max(0, n))
    for (const item of taken) this.pendingRefs.delete(item.sourceRef)
    return taken
  }

  /** Number of items currently waiting. */
  size(): number {
    return this.pending.length
  }

  /** Count of items dropped because the queue was full (for metrics/alarms). */
  dropped(): number {
    return this.droppedWhenFull
  }
}
