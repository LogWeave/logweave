export interface TenantSettings {
  slackWebhookUrl?: string
  lastTestStatus?: 'success' | 'failed'
  lastTestAt?: string
}

/**
 * In-memory per-tenant settings store.
 *
 * Maps tenantId to settings. Resets on server restart.
 * Persistence is a fast-follow, same as WatchStore.
 */
export class TenantSettingsStore {
  private readonly settings = new Map<string, TenantSettings>()

  /** Get settings for a tenant. Returns empty object if none exist. */
  get(tenantId: string): TenantSettings {
    return this.settings.get(tenantId) ?? {}
  }

  /** Merge partial updates into a tenant's settings. */
  set(tenantId: string, updates: Partial<TenantSettings>): void {
    const existing = this.settings.get(tenantId) ?? {}
    this.settings.set(tenantId, { ...existing, ...updates })
  }

  /** Get the Slack webhook URL for a tenant, or undefined if not configured. */
  getSlackUrl(tenantId: string): string | undefined {
    return this.settings.get(tenantId)?.slackWebhookUrl
  }

  /** Remove Slack configuration and test status for a tenant. */
  clearSlack(tenantId: string): void {
    this.settings.delete(tenantId)
  }
}
