import type pino from 'pino'
import type { ClustererHealthChecker } from '../clients/clusterer.js'
import type { DbClient } from '../db/client.js'
import { batchInsert } from '../db/insert.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'
import type { LogMetadataRow } from '../types.js'

interface UnclusteredRow {
  id: string
  tenant_id: string
  timestamp: string
  service: string
  level: string
  environment: string
  anomaly_score: number
  status_code: number
  duration_ms: number
  trace_id: string
  route: string
  source_type: string
  source_ref: string
  pre_processed_message: string
  preprocessing_version: number
}

export interface RecoveryDependencies {
  db: DbClient
  clusterClient: ClusterClient
  clustererHealth: ClustererHealthChecker
  logger: pino.Logger
}

export interface RecoveryConfig {
  sweepIntervalMs: number
  sweepMaxRows: number
  batchSize: number
  backpressureThresholdMs: number
}

const UUID_MIN = '00000000-0000-0000-0000-000000000000'

// Cross-tenant SELECT is intentional — recovery is an internal background process
// that must recover all tenants' unclustered rows. Rows are grouped by tenant_id
// in application code before calling the per-tenant clusterer endpoint.
const UNCLUSTERED_QUERY = `
SELECT id, tenant_id, timestamp, service, level, environment,
       anomaly_score, status_code, duration_ms, trace_id, route,
       source_type, source_ref, pre_processed_message, preprocessing_version
FROM logweave.log_metadata
WHERE template_id = '0'
  AND pre_processed_message IS NOT NULL
  AND ingest_time > now64(3) - INTERVAL 24 HOUR
  AND id > {cursor:String}
ORDER BY id ASC
LIMIT {batch_size:UInt32}`

/**
 * Recovery system for re-clustering template_id='0' rows.
 *
 * Uses INSERT-first then DELETE ordering to prevent data loss on crash.
 *
 * Known tradeoff: service_stats_mv fires on all inserts (no WHERE filter),
 * so re-INSERT causes double-counting in service stats. This is accepted
 * for MVP — recovery rows are a small fraction of total volume.
 * template_stats_mv (WHERE template_id != '0') fires correctly only on
 * the recovery INSERT, which is the desired behavior.
 */
export class RecoverySweep {
  private sweepRunning = false
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(
    private deps: RecoveryDependencies,
    private config: RecoveryConfig,
  ) {}

  /**
   * Run once at startup. Checks clusterer health first.
   * Returns total recovered count (0 if clusterer is down).
   */
  async runStartupReconciliation(): Promise<number> {
    if (this.sweepRunning) return 0

    if (this.deps.clusterClient.isCircuitOpen) {
      this.deps.logger.info('Clusterer circuit open, skipping reconciliation')
      return 0
    }

    const healthy = await this.deps.clustererHealth.check()
    if (!healthy) {
      this.deps.logger.info('Clusterer unavailable at startup, skipping reconciliation')
      return 0
    }

    return this.sweep(this.config.sweepMaxRows)
  }

  /** Start periodic background sweep. */
  start(): void {
    this.intervalHandle = setInterval(async () => {
      if (this.sweepRunning) {
        this.deps.logger.debug('Sweep already running, skipping')
        return
      }
      if (this.deps.clusterClient.isCircuitOpen) return
      const healthy = await this.deps.clustererHealth.check()
      if (!healthy) return
      try {
        const recovered = await this.sweep(this.config.sweepMaxRows)
        if (recovered > 0) {
          this.deps.logger.info({ recovered }, 'Recovery sweep completed')
        }
      } catch (err) {
        this.deps.logger.error({ err }, 'Recovery sweep failed')
      }
    }, this.config.sweepIntervalMs)
    this.intervalHandle.unref()
  }

  /** Stop periodic sweep and wait for in-flight sweep to finish. */
  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    const deadline = Date.now() + 5_000
    while (this.sweepRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * Core sweep: cursor-paginated recovery loop.
   * Mutex-guarded — only one sweep runs at a time.
   */
  private async sweep(maxRows: number): Promise<number> {
    if (this.sweepRunning) return 0
    this.sweepRunning = true

    try {
      let cursor = UUID_MIN
      let totalRecovered = 0

      while (totalRecovered < maxRows) {
        const remaining = maxRows - totalRecovered
        const limit = Math.min(this.config.batchSize, remaining)

        const rows = await this.fetchPage(cursor, limit)
        if (rows.length === 0) break

        // Group by tenant_id
        const byTenant = new Map<string, UnclusteredRow[]>()
        for (const row of rows) {
          const list = byTenant.get(row.tenant_id)
          if (list) {
            list.push(row)
          } else {
            byTenant.set(row.tenant_id, [row])
          }
        }

        let backpressureTriggered = false

        for (const [tenantId, tenantRows] of byTenant) {
          const recovered = await this.recoverTenantBatch(tenantId, tenantRows)
          if (recovered < 0) {
            // Backpressure triggered
            backpressureTriggered = true
            break
          }
          totalRecovered += recovered
        }

        if (backpressureTriggered) break

        // Advance cursor to last row's id
        cursor = rows[rows.length - 1]!.id
      }

      return totalRecovered
    } finally {
      this.sweepRunning = false
    }
  }

  /**
   * Recover one tenant's batch of unclustered rows.
   * Returns recovered count, or -1 if backpressure triggered.
   */
  private async recoverTenantBatch(tenantId: string, rows: UnclusteredRow[]): Promise<number> {
    const messages = rows.map((r) => r.pre_processed_message)

    const start = Date.now()
    const results = await this.deps.clusterClient.cluster(tenantId, messages)
    const elapsed = Date.now() - start

    if (elapsed > this.config.backpressureThresholdMs) {
      this.deps.logger.warn(
        { tenantId, elapsed, threshold: this.config.backpressureThresholdMs },
        'Clusterer response slow, aborting sweep',
      )
      return -1
    }

    // Filter out rows that are still unclustered (clusterer still failing)
    const recoverable: Array<{ row: UnclusteredRow; result: (typeof results)[0] }> = []
    for (let i = 0; i < rows.length; i++) {
      if (results[i]!.templateId !== '0') {
        recoverable.push({ row: rows[i]!, result: results[i]! })
      }
    }

    if (recoverable.length === 0) return 0

    // Build new rows (omit id — let ClickHouse auto-generate new UUIDv7)
    const newRows: LogMetadataRow[] = recoverable.map(({ row, result }) => ({
      tenant_id: row.tenant_id,
      timestamp: row.timestamp,
      service: row.service,
      level: row.level,
      environment: row.environment,
      template_id: result.templateId,
      template_text: result.templateText,
      is_new_template: 0, // Recovery re-clustering, not a new template discovery
      anomaly_score: row.anomaly_score,
      status_code: row.status_code,
      duration_ms: row.duration_ms,
      trace_id: row.trace_id,
      route: row.route,
      source_type: row.source_type,
      source_ref: row.source_ref,
      pre_processed_message: null,
      preprocessing_version: row.preprocessing_version,
    }))

    const oldIds = recoverable.map(({ row }) => row.id)

    // INSERT first (safe ordering — no data loss on crash)
    try {
      await batchInsert(this.deps.db, newRows)
    } catch (err) {
      this.deps.logger.error(
        { err, tenantId, count: newRows.length },
        'Recovery INSERT failed, skipping batch',
      )
      return 0
    }

    // Then DELETE old rows
    try {
      await this.deps.db.command({
        query: `DELETE FROM logweave.log_metadata WHERE id IN {ids:Array(String)} AND tenant_id = {tenant_id:String}`,
        query_params: { ids: oldIds, tenant_id: tenantId },
      })
    } catch (err) {
      this.deps.logger.warn(
        { err, tenantId, count: oldIds.length },
        'Recovery DELETE failed after INSERT — duplicates until next merge',
      )
    }

    return recoverable.length
  }

  private async fetchPage(cursor: string, limit: number): Promise<UnclusteredRow[]> {
    return this.deps.db.query<UnclusteredRow>({
      query: UNCLUSTERED_QUERY,
      query_params: { cursor, batch_size: limit },
    })
  }
}
