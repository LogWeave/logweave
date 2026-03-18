const DEFAULT_MAX_WATCHES_PER_TENANT = 100

/**
 * In-memory store for template watches.
 *
 * Maps tenantId → templateId → templateText. Resets on server restart.
 * Persistence is a fast-follow — acceptable for dev/demo use.
 */
export class WatchStore {
  private readonly maxPerTenant: number
  private readonly watches = new Map<string, Map<string, string>>()

  constructor(maxPerTenant = DEFAULT_MAX_WATCHES_PER_TENANT) {
    this.maxPerTenant = maxPerTenant
  }

  /**
   * Add a watch. Returns true if newly added, false if already watched,
   * or 'limit_exceeded' if the tenant has reached the watch limit.
   */
  add(tenantId: string, templateId: string, templateText = ''): true | false | 'limit_exceeded' {
    let tenantMap = this.watches.get(tenantId)
    if (!tenantMap) {
      tenantMap = new Map()
      this.watches.set(tenantId, tenantMap)
    }
    if (tenantMap.has(templateId)) return false
    if (tenantMap.size >= this.maxPerTenant) return 'limit_exceeded'
    tenantMap.set(templateId, templateText)
    return true
  }

  /** Remove a watch. Returns true if it was present. */
  remove(tenantId: string, templateId: string): boolean {
    const tenantMap = this.watches.get(tenantId)
    if (!tenantMap) return false
    const deleted = tenantMap.delete(templateId)
    if (tenantMap.size === 0) this.watches.delete(tenantId)
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
