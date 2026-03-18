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

    const rows = await this.db.query<WatchRow>({
      query: `SELECT tenant_id, template_id, template_text
              FROM logweave.watches FINAL
              WHERE is_deleted = 0`,
    })

    for (const row of rows) {
      let tenantMap = this.watches.get(row.tenant_id)
      if (!tenantMap) {
        tenantMap = new Map()
        this.watches.set(row.tenant_id, tenantMap)
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
      await this.db.insert({
        table: 'logweave.watches',
        values: [
          {
            tenant_id: tenantId,
            template_id: templateId,
            template_text: templateText,
            is_deleted: 0,
          },
        ],
        format: 'JSONEachRow',
      })
    }

    return true
  }

  /** Remove a watch. Returns true if it was present. */
  async remove(tenantId: string, templateId: string): Promise<boolean> {
    const tenantMap = this.watches.get(tenantId)
    if (!tenantMap) return false
    const deleted = tenantMap.delete(templateId)
    if (tenantMap.size === 0) this.watches.delete(tenantId)

    if (deleted && this.db) {
      await this.db.insert({
        table: 'logweave.watches',
        values: [
          { tenant_id: tenantId, template_id: templateId, template_text: '', is_deleted: 1 },
        ],
        format: 'JSONEachRow',
      })
    }

    return deleted
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
