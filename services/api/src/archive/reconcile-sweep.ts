/**
 * Archive reconciliation sweep (epic #265, #279).
 *
 * The notify→consumer path (#276/#277) is best-effort: the in-proc queue drops
 * on overflow or a restart, and the consumer drops after retry exhaustion. Those
 * objects are still durably in the customer's S3 — only their metadata is
 * missing. This background sweep finds them and re-feeds the EXISTING consumer:
 * per tenant it lists archived objects from a durable watermark, checks which
 * are absent from log_metadata, and enqueues the gaps into the same
 * ArchiveNotifyQueue the consumer drains (which GETs + clusters + inserts,
 * idempotent by event_id). It writes no metadata itself.
 *
 * Watermark semantics: the cursor is "every object lexically <= last_key is
 * confirmed (ingested or quarantined)". A run advances it only to the key just
 * before the earliest *actively-retrying* gap, so a transiently-dropped object
 * stays in the listing window across sweeps until it lands — never skipped.
 *
 * Quarantine: some objects can never produce a row — e.g. an object whose events
 * all fail parsing, or a corrupt/zero-event object the consumer treats as a
 * no-op success. Such a poison object would otherwise block the watermark
 * forever, and (past `maxKeysPerSweep`) starve every later object from ever
 * being listed. So a gap that is still missing after `quarantineThreshold`
 * consecutive sweeps stops blocking the watermark and emits a loud operator
 * event — the sweep gives up on it, exactly as the consumer drops after its own
 * retry budget. Miss counts are in-memory (a restart just re-attempts).
 */
import type pino from 'pino'
import type { S3ConnectorConfig } from '../connectors/types.js'
import {
  getExistingSourceRefs,
  getReconcileCursor,
  setReconcileCursor,
} from '../db/archive-reconcile-queries.js'
import type { DbClient } from '../db/client.js'
import type { EmitInput } from '../internal-events/emitter.js'
import type { ArchiveNotifyQueue } from './notify-queue.js'

interface ObjectLister {
  listObjectKeys(
    config: S3ConnectorConfig,
    prefix: string,
    startAfter: string | undefined,
    maxKeys: number,
  ): Promise<{ keys: string[]; lastKey: string | undefined }>
}

export interface ReconcileSweepDeps {
  db: DbClient
  adapter: ObjectLister
  archiveConfig: S3ConnectorConfig
  queue: ArchiveNotifyQueue
  settingsStore: { getAllTenantIds(): string[] }
  logger: pino.Logger
  /** Operator-feed emitter for the "behind by > threshold" alert. */
  emitter: { emit(input: EmitInput): void }
}

export interface ReconcileSweepConfig {
  /** Interval between sweeps, ms. Default: 5 min. */
  intervalMs?: number
  /** Max object keys listed per tenant per run. Default: 5000. */
  maxKeysPerSweep?: number
  /** Missing objects in a single tenant run that trips the alert. Default: 100. */
  behindThreshold?: number
  /**
   * Consecutive sweeps a gap may stay missing before it is quarantined (stops
   * blocking the watermark + alerts). Default: 5.
   */
  quarantineThreshold?: number
}

export interface ReconcileResult {
  tenantsProcessed: number
  objectsListed: number
  missingEnqueued: number
}

export class ArchiveReconcileSweep {
  private readonly intervalMs: number
  private readonly maxKeysPerSweep: number
  private readonly behindThreshold: number
  private readonly quarantineThreshold: number
  /** Per-key consecutive-miss count (`tenantId\nkey` → count). Bounds the wedge. */
  private readonly missCounts = new Map<string, number>()
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly deps: ReconcileSweepDeps,
    config: ReconcileSweepConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 300_000
    this.maxKeysPerSweep = config.maxKeysPerSweep ?? 5000
    this.behindThreshold = config.behindThreshold ?? 100
    this.quarantineThreshold = config.quarantineThreshold ?? 5
  }

  start(): void {
    if (this.intervalHandle) return // idempotent — don't leak a second timer
    this.intervalHandle = setInterval(() => {
      if (this.running) return
      this.running = true
      this.reconcileOnce()
        .then((result) => {
          if (result.missingEnqueued > 0) {
            this.deps.logger.info(result, 'Archive reconciliation enqueued missing objects')
          }
        })
        .catch((err) => this.deps.logger.error({ err }, 'Archive reconciliation sweep failed'))
        .finally(() => {
          this.running = false
        })
    }, this.intervalMs)
    this.intervalHandle.unref()
    this.deps.logger.info({ intervalMs: this.intervalMs }, 'Archive reconciliation sweep started')
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    // Let an in-flight sweep settle before shutdown closes the DB (mirrors the
    // consumer's stop()), bounded so a wedged sweep can't block shutdown.
    for (let i = 0; this.running && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async reconcileOnce(): Promise<ReconcileResult> {
    const result: ReconcileResult = { tenantsProcessed: 0, objectsListed: 0, missingEnqueued: 0 }
    for (const tenantId of this.deps.settingsStore.getAllTenantIds()) {
      result.tenantsProcessed++
      try {
        const tenantResult = await this.reconcileTenant(tenantId)
        result.objectsListed += tenantResult.listed
        result.missingEnqueued += tenantResult.missing
      } catch (err) {
        this.deps.logger.error({ err, tenantId }, 'Archive reconciliation failed for tenant')
      }
    }
    return result
  }

  private async reconcileTenant(tenantId: string): Promise<{ listed: number; missing: number }> {
    const cursor = await getReconcileCursor(this.deps.db, tenantId)
    const { keys } = await this.deps.adapter.listObjectKeys(
      this.deps.archiveConfig,
      `tenant=${tenantId}/`,
      cursor || undefined,
      this.maxKeysPerSweep,
    )
    if (keys.length === 0) return { listed: 0, missing: 0 }

    const existing = await getExistingSourceRefs(this.deps.db, tenantId, keys)

    // Walk keys in lexical (== S3 listing == cursor) order. Enqueue every gap.
    // The watermark may advance past confirmed keys and past quarantined gaps
    // (still missing after quarantineThreshold sweeps), but NOT past a gap we
    // are still actively retrying — that one stays in the listing window.
    let earliestBlockingIndex = -1
    let missing = 0
    for (const [i, key] of keys.entries()) {
      const mk = `${tenantId}\n${key}`
      if (existing.has(key)) {
        this.missCounts.delete(mk) // confirmed — forget any prior miss count
        continue
      }
      missing++
      this.deps.queue.enqueue({ tenantId, sourceRef: key })
      const count = (this.missCounts.get(mk) ?? 0) + 1
      if (count >= this.quarantineThreshold) {
        // Give up on this poison object: let the watermark pass it so the tail
        // beyond maxKeysPerSweep is never starved. Loud — an operator must see
        // that an archived object will never be reflected in metadata.
        this.missCounts.delete(mk)
        this.deps.emitter.emit({
          event: 'archive.object_quarantined',
          severity: 'warn',
          code: 'ARCHIVE_OBJECT_QUARANTINED',
          summary: 'archived object never produced metadata after repeated retries',
          fields: { tenant_id: tenantId, source_ref: key, sweeps: count },
        })
      } else {
        this.missCounts.set(mk, count)
        if (earliestBlockingIndex === -1) earliestBlockingIndex = i
      }
    }

    // New watermark: last key before the earliest actively-retrying gap. If the
    // first listed key is the blocker, there is nothing new to confirm.
    let newCursor: string | undefined
    if (earliestBlockingIndex === -1) {
      newCursor = keys.at(-1)
    } else if (earliestBlockingIndex > 0) {
      newCursor = keys[earliestBlockingIndex - 1]
    }
    if (newCursor !== undefined && newCursor !== cursor) {
      await setReconcileCursor(this.deps.db, tenantId, newCursor)
    }

    if (missing >= this.behindThreshold) {
      this.deps.emitter.emit({
        event: 'archive.reconcile_behind',
        severity: 'warn',
        code: 'ARCHIVE_RECONCILE_BEHIND',
        summary: 'archive reconciliation found many un-ingested objects',
        fields: { tenant_id: tenantId, missing, listed: keys.length },
      })
    }

    return { listed: keys.length, missing }
  }
}
