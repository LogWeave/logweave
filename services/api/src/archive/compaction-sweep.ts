/**
 * Archive compaction sweep (epic #265, #284).
 *
 * Vector flushes a new S3 object per batch/timeout, so low-volume partitions
 * accumulate many small objects — eroding the PUT-economics win over CloudWatch
 * and cluttering the archive. This nightly job merges the small objects in a
 * CLOSED partition (tenant/service/date/hour) into one, de-duped by event_id,
 * repoints the affected source_refs, and deletes the originals.
 *
 * Safety (destructive on the customer's own S3 — ordered so nothing is lost):
 *   1. read every original's events, dedupe by event_id (the compacted object is
 *      a superset of all originals);
 *   2. PUT the compacted object (durable) at a DETERMINISTIC key;
 *   3. repoint source_refs in log_metadata SYNCHRONOUSLY (mutations_sync=2);
 *   4. only then delete the originals.
 * A crash between 2 and 4 is safe: the deterministic key means a re-run rebuilds
 * the identical object, the repoint is idempotent, and the originals are still
 * present to re-delete. Compacted objects (`_compacted-…`) are never re-read.
 *
 * Only CLOSED partitions (ended more than `safetyLagHours` ago) are touched, so
 * compaction never races an hour that is still being written or backfilled.
 */
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type pino from 'pino'
import type { S3ConnectorConfig } from '../connectors/types.js'
import { repointSourceRefs } from '../db/archive-compaction-queries.js'
import type { DbClient } from '../db/client.js'

const gzipAsync = promisify(gzip)

/** Marks a compacted object so the sweep never re-compacts its own output. */
const COMPACTED_MARKER = '_compacted-'

interface CompactionAdapter {
  listObjectKeys(
    config: S3ConnectorConfig,
    prefix: string,
    startAfter: string | undefined,
    maxKeys: number,
  ): Promise<{ keys: string[]; lastKey: string | undefined }>
  fetchObjectEvents(config: S3ConnectorConfig, key: string): Promise<unknown[]>
  putObject(config: S3ConnectorConfig, key: string, gzipBody: Buffer): Promise<void>
  deleteObjects(config: S3ConnectorConfig, keys: readonly string[]): Promise<void>
}

export interface CompactionSweepDeps {
  db: DbClient
  adapter: CompactionAdapter
  archiveConfig: S3ConnectorConfig
  settingsStore: { getAllTenantIds(): string[] }
  logger: pino.Logger
}

export interface CompactionSweepConfig {
  /** Interval between sweeps, ms. Default: 24h. */
  intervalMs?: number
  /** Minimum originals in a partition before it is worth compacting. Default: 2. */
  minObjectsToCompact?: number
  /** A partition is compactable only once its hour ended this long ago. Default: 2h. */
  safetyLagHours?: number
  /** Max object keys listed per tenant per run. Default: 10000. */
  maxKeysPerSweep?: number
}

export interface CompactionResult {
  partitionsCompacted: number
  objectsRemoved: number
}

export class ArchiveCompactionSweep {
  private readonly intervalMs: number
  private readonly minObjects: number
  private readonly safetyLagMs: number
  private readonly maxKeysPerSweep: number
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly deps: CompactionSweepDeps,
    config: CompactionSweepConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 86_400_000
    this.minObjects = config.minObjectsToCompact ?? 2
    this.safetyLagMs = (config.safetyLagHours ?? 2) * 3_600_000
    this.maxKeysPerSweep = config.maxKeysPerSweep ?? 10_000
  }

  start(): void {
    if (this.intervalHandle) return
    this.intervalHandle = setInterval(() => {
      if (this.running) return
      this.running = true
      this.compactOnce()
        .then((result) => {
          if (result.partitionsCompacted > 0) {
            this.deps.logger.info(result, 'Archive compaction merged partitions')
          }
        })
        .catch((err) => this.deps.logger.error({ err }, 'Archive compaction sweep failed'))
        .finally(() => {
          this.running = false
        })
    }, this.intervalMs)
    this.intervalHandle.unref()
    this.deps.logger.info({ intervalMs: this.intervalMs }, 'Archive compaction sweep started')
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    for (let i = 0; this.running && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async compactOnce(): Promise<CompactionResult> {
    const result: CompactionResult = { partitionsCompacted: 0, objectsRemoved: 0 }
    for (const tenantId of this.deps.settingsStore.getAllTenantIds()) {
      try {
        const t = await this.compactTenant(tenantId)
        result.partitionsCompacted += t.partitionsCompacted
        result.objectsRemoved += t.objectsRemoved
      } catch (err) {
        this.deps.logger.error({ err, tenantId }, 'Archive compaction failed for tenant')
      }
    }
    return result
  }

  private async compactTenant(tenantId: string): Promise<CompactionResult> {
    const { keys } = await this.deps.adapter.listObjectKeys(
      this.deps.archiveConfig,
      `tenant=${tenantId}/`,
      undefined,
      this.maxKeysPerSweep,
    )

    // Group originals by partition prefix (everything up to the last '/').
    const partitions = new Map<string, string[]>()
    for (const key of keys) {
      const slash = key.lastIndexOf('/')
      const filename = key.slice(slash + 1)
      if (filename.startsWith(COMPACTED_MARKER)) continue // never re-compact our output
      const prefix = key.slice(0, slash + 1)
      const group = partitions.get(prefix)
      if (group) group.push(key)
      else partitions.set(prefix, [key])
    }

    const result: CompactionResult = { partitionsCompacted: 0, objectsRemoved: 0 }
    for (const [prefix, originals] of partitions) {
      if (originals.length < this.minObjects) continue
      if (!this.isClosed(prefix)) continue
      await this.compactPartition(tenantId, prefix, originals)
      result.partitionsCompacted++
      result.objectsRemoved += originals.length
    }
    return result
  }

  /** A partition is closed when its hour ended more than safetyLag ago. */
  private isClosed(prefix: string): boolean {
    const m = prefix.match(/date=(\d{4})-(\d{2})-(\d{2})\/hour=(\d{2})\//)
    if (!m) return false // unknown layout — never compact
    const [, y, mo, d, h] = m
    const hourStart = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h))
    const hourEnd = hourStart + 3_600_000
    return Date.now() - hourEnd > this.safetyLagMs
  }

  private async compactPartition(
    tenantId: string,
    prefix: string,
    originals: string[],
  ): Promise<void> {
    // 1. Read + dedupe by event_id (events without one are always kept).
    const seen = new Set<string>()
    const merged: unknown[] = []
    for (const key of originals) {
      for (const event of await this.deps.adapter.fetchObjectEvents(this.deps.archiveConfig, key)) {
        const id =
          typeof event === 'object' && event !== null
            ? (event as Record<string, unknown>).event_id
            : undefined
        if (typeof id === 'string') {
          if (seen.has(id)) continue
          seen.add(id)
        }
        merged.push(event)
      }
    }
    if (merged.length === 0) return // nothing readable — leave originals alone

    // 2. PUT the compacted object at a deterministic key (idempotent re-runs).
    const hash = createHash('sha256')
      .update([...originals].sort().join('\n'))
      .digest('hex')
      .slice(0, 16)
    const compactedKey = `${prefix}${COMPACTED_MARKER}${hash}.log.gz`
    const ndjson = `${merged.map((e) => JSON.stringify(e)).join('\n')}\n`
    const body = await gzipAsync(Buffer.from(ndjson))
    await this.deps.adapter.putObject(this.deps.archiveConfig, compactedKey, body)

    // 3. Repoint source_refs (synchronous), THEN 4. delete originals.
    await repointSourceRefs(this.deps.db, tenantId, originals, compactedKey)
    await this.deps.adapter.deleteObjects(this.deps.archiveConfig, originals)
  }
}
