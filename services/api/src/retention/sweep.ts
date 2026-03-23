import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'

const DEFAULT_RETENTION_DAYS = 30

/**
 * Tables with their timestamp column for retention DELETE.
 * Excludes service_stats_5m (7-day TTL, too short-lived to matter)
 * and tables whose TTL already exceeds max retention (template_daily, deploy_correlation at 365d).
 */
const RETENTION_TABLES: Array<{ table: string; timestampColumn: string }> = [
  { table: 'logweave.log_metadata', timestampColumn: 'timestamp' },
  { table: 'logweave.template_stats', timestampColumn: 'interval_start' },
  { table: 'logweave.service_stats', timestampColumn: 'interval_start' },
  { table: 'logweave.deploys', timestampColumn: 'timestamp' },
  { table: 'logweave.alert_history', timestampColumn: 'fired_at' },
]

export interface SweepResult {
  tenantsProcessed: number
  deletesIssued: number
  errors: number
}

export interface RetentionSweepDeps {
  db: DbClient
  settingsStore: TenantSettingsStore
  logger: pino.Logger
}

export interface RetentionSweepConfig {
  intervalMs?: number
  enabled?: boolean
}

/**
 * Background job that enforces per-tenant data retention.
 *
 * Table-level TTLs (30d) serve as a safety net for all tenants.
 * This sweep handles tenants whose retention period differs from
 * the table default — deleting data older than their configured
 * retentionDays using ClickHouse lightweight DELETE.
 */
export class RetentionSweep {
  private readonly db: DbClient
  private readonly settingsStore: TenantSettingsStore
  private readonly logger: pino.Logger
  private readonly intervalMs: number
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(deps: RetentionSweepDeps, config: RetentionSweepConfig = {}) {
    this.db = deps.db
    this.settingsStore = deps.settingsStore
    this.logger = deps.logger
    this.intervalMs = config.intervalMs ?? 86_400_000 // 24h default
  }

  start(): void {
    this.intervalHandle = setInterval(async () => {
      if (this.running) return
      this.running = true
      try {
        const result = await this.sweep()
        if (result.tenantsProcessed > 0) {
          this.logger.info(result, 'Retention sweep completed')
        }
      } catch (err) {
        this.logger.error({ err }, 'Retention sweep failed')
      } finally {
        this.running = false
      }
    }, this.intervalMs)
    this.logger.info({ intervalMs: this.intervalMs }, 'Retention sweep started')
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  async sweep(): Promise<SweepResult> {
    const result: SweepResult = { tenantsProcessed: 0, deletesIssued: 0, errors: 0 }
    const tenantIds = this.settingsStore.getAllTenantIds()

    for (const tenantId of tenantIds) {
      const settings = this.settingsStore.get(tenantId)
      const retentionDays = settings.retentionDays ?? DEFAULT_RETENTION_DAYS

      // Skip tenants at default retention — table-level TTL handles them
      if (retentionDays <= DEFAULT_RETENTION_DAYS) continue

      result.tenantsProcessed++

      for (const { table, timestampColumn } of RETENTION_TABLES) {
        try {
          await this.db.command({
            query: `ALTER TABLE ${table} DELETE WHERE tenant_id = {tenant_id:String} AND ${timestampColumn} < now() - toIntervalDay({retention_days:UInt32})`,
            query_params: { tenant_id: tenantId, retention_days: retentionDays },
          })
          result.deletesIssued++
        } catch (err) {
          result.errors++
          this.logger.error(
            { err, tenantId, table },
            'Retention DELETE failed for table',
          )
        }
      }
    }

    return result
  }
}
