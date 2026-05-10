import type pino from 'pino'
import type { DbClient } from '../db/client.js'

const DEFAULT_MAX_WATCHES_PER_TENANT = 100

interface WatchRow {
  tenant_id: string
  template_id: string
  template_text: string
}

export interface WatchStoreOpts {
  db?: DbClient
  logger?: pino.Logger
  maxPerTenant?: number
}

/**
 * Write-through cached store for template watches.
 *
 * Reads from in-memory Map for speed. Mutations persist to ClickHouse
 * so watches survive server restarts.
 */
export class WatchStore {
  private readonly maxPerTenant: number
  private readonly watches = new Map<string, Map<string, string>>()
  private readonly db?: DbClient
  private readonly logger?: pino.Logger

  constructor(opts: WatchStoreOpts = {}) {
    this.maxPerTenant = opts.maxPerTenant ?? DEFAULT_MAX_WATCHES_PER_TENANT
    this.db = opts.db
    this.logger = opts.logger
  }

  /** Load all watches from ClickHouse into memory. Call once at startup. */
  async loadFromDb(): Promise<{ watchCount: number; tenantCount: number }> {
    if (!this.db) return { watchCount: 0, tenantCount: 0 }

    // Hard cap on the boot-time load. A pathological tenant or a bug that
    // wrote millions of rows would otherwise OOM startup. Per-tenant overflow
    // is logged and skipped via the maxPerTenant check below.
    const STARTUP_LOAD_LIMIT = 100_000
    const rows = await this.db.query<WatchRow>({
      query: `SELECT tenant_id, template_id, template_text
              FROM logweave.watches FINAL
              WHERE is_deleted = 0
              LIMIT {limit:UInt32}`,
      query_params: { limit: STARTUP_LOAD_LIMIT },
    })

    for (const row of rows) {
      let tenantMap = this.watches.get(row.tenant_id)
      if (!tenantMap) {
        tenantMap = new Map()
        this.watches.set(row.tenant_id, tenantMap)
      }
      if (tenantMap.size >= this.maxPerTenant) {
        this.logger?.warn(
          { tenantId: row.tenant_id, maxPerTenant: this.maxPerTenant },
          'Tenant exceeds watch limit in ClickHouse — skipping excess watches',
        )
        continue
      }
      tenantMap.set(row.template_id, row.template_text)
    }

    const watchCount = rows.length
    const tenantCount = this.watches.size
    this.logger?.info({ watchCount, tenantCount }, 'Loaded watches from ClickHouse')
    return { watchCount, tenantCount }
  }

  /**
   * Add a watch. Returns true if newly added, false if already watched,
   * or 'limit_exceeded' if the tenant has reached the watch limit.
   */
  async add(
    tenantId: string,
    templateId: string,
    templateText = '',
  ): Promise<true | false | 'limit_exceeded'> {
    let tenantMap = this.watches.get(tenantId)
    if (!tenantMap) {
      tenantMap = new Map()
      this.watches.set(tenantId, tenantMap)
    }
    if (tenantMap.has(templateId)) return false
    if (tenantMap.size >= this.maxPerTenant) return 'limit_exceeded'
    tenantMap.set(templateId, templateText)

    if (this.db) {
      try {
        await this.db.insert({
          table: 'logweave.watches',
          values: [
            {
              tenant_id: tenantId,
              template_id: templateId,
              template_text: templateText,
              version: Date.now(),
              is_deleted: 0,
            },
          ],
          format: 'JSONEachRow',
        })
      } catch (err) {
        tenantMap.delete(templateId)
        if (tenantMap.size === 0) this.watches.delete(tenantId)
        throw err
      }
    }

    return true
  }

  /** Remove a watch. Returns true if it was present. */
  async remove(tenantId: string, templateId: string): Promise<boolean> {
    const tenantMap = this.watches.get(tenantId)
    if (!tenantMap) return false
    const templateText = tenantMap.get(templateId)
    if (templateText === undefined) return false

    tenantMap.delete(templateId)
    if (tenantMap.size === 0) this.watches.delete(tenantId)

    if (this.db) {
      try {
        await this.db.insert({
          table: 'logweave.watches',
          values: [
            {
              tenant_id: tenantId,
              template_id: templateId,
              template_text: '',
              version: Date.now(),
              is_deleted: 1,
            },
          ],
          format: 'JSONEachRow',
        })
      } catch (err) {
        let restored = this.watches.get(tenantId)
        if (!restored) {
          restored = new Map()
          this.watches.set(tenantId, restored)
        }
        restored.set(templateId, templateText)
        throw err
      }
    }

    return true
  }

  /** Check if a template is watched. */
  has(tenantId: string, templateId: string): boolean {
    return this.watches.get(tenantId)?.has(templateId) ?? false
  }

  /** List watched templateIds for a tenant (sorted). */
  list(tenantId: string): string[] {
    const tenantMap = this.watches.get(tenantId)
    if (!tenantMap) return []
    return [...tenantMap.keys()].sort()
  }

  /** Get stored template text for a watch. */
  getTemplateText(tenantId: string, templateId: string): string {
    return this.watches.get(tenantId)?.get(templateId) ?? ''
  }

  /** Get all watches grouped by tenant (for evaluator iteration). */
  getWatchedByTenant(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>()
    for (const [tenantId, tenantMap] of this.watches) {
      result.set(tenantId, new Set(tenantMap.keys()))
    }
    return result
  }
}
