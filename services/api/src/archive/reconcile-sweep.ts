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
 * confirmed in log_metadata". A run advances it only to the key just before the
 * earliest still-missing object, so a transiently-dropped object stays in the
 * listing window across sweeps until it actually lands — it is never skipped.
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
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly deps: ReconcileSweepDeps,
    config: ReconcileSweepConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 300_000
    this.maxKeysPerSweep = config.maxKeysPerSweep ?? 5000
    this.behindThreshold = config.behindThreshold ?? 100
  }

  start(): void {
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

    // Walk keys in lexical (== S3 listing == cursor) order. Enqueue every gap;
    // remember the first gap so the watermark never advances past it.
    let earliestMissingIndex = -1
    let missing = 0
    for (const [i, key] of keys.entries()) {
      if (existing.has(key)) continue
      if (earliestMissingIndex === -1) earliestMissingIndex = i
      missing++
      this.deps.queue.enqueue({ tenantId, sourceRef: key })
    }

    // New watermark: last contiguously-confirmed key. If the first listed key is
    // already missing, there is nothing new to confirm — leave the cursor be.
    let newCursor: string | undefined
    if (earliestMissingIndex === -1) {
      newCursor = keys.at(-1)
    } else if (earliestMissingIndex > 0) {
      newCursor = keys[earliestMissingIndex - 1]
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
