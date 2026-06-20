import type pino from 'pino'
import { decrypt, encrypt } from '../crypto.js'
import type { DbClient } from '../db/client.js'

export type TailMode = 'disabled' | 'metadata' | 'preprocessed'

export interface TenantSettings {
  slackWebhookUrl?: string
  lastTestStatus?: 'success' | 'failed'
  lastTestAt?: string
  tailMode?: TailMode
  retentionDays?: number
  maintenanceUntil?: string
  extractTags?: string[]
  lastMcpConnectionAt?: string
  onboardingDismissedAt?: string
  clusteringSensitivity?: number
  minIngestLevel?: string
  costNoiseDebugPct?: number
  costReviewInfoPct?: number
  costReviewWarnPct?: number
  spikeMinBaseline?: number
}

interface SettingsRow {
  tenant_id: string
  setting_key: string
  setting_value: string
}

const SETTING_KEYS: (keyof TenantSettings)[] = [
  'slackWebhookUrl',
  'lastTestStatus',
  'lastTestAt',
  'tailMode',
  'retentionDays',
  'maintenanceUntil',
  'extractTags',
  'lastMcpConnectionAt',
  'onboardingDismissedAt',
  'clusteringSensitivity',
  'minIngestLevel',
  'costNoiseDebugPct',
  'costReviewInfoPct',
  'costReviewWarnPct',
  'spikeMinBaseline',
]

export interface TenantSettingsStoreOpts {
  db?: DbClient
  logger?: pino.Logger
  /** Encrypts slackWebhookUrl at rest. When unset, the URL is stored plaintext (dev). */
  encryptionKey?: string
}

/**
 * Write-through cached per-tenant settings store.
 *
 * Reads from in-memory Map. Mutations persist to ClickHouse
 * so settings survive server restarts.
 */
export class TenantSettingsStore {
  private readonly settings = new Map<string, TenantSettings>()
  private readonly db?: DbClient
  private readonly logger?: pino.Logger
  private readonly encryptionKey?: string

  constructor(opts: TenantSettingsStoreOpts = {}) {
    this.db = opts.db
    this.logger = opts.logger
    this.encryptionKey = opts.encryptionKey
  }

  /** Load all settings from ClickHouse into memory. Call once at startup. */
  async loadFromDb(): Promise<{ settingCount: number; tenantCount: number }> {
    if (!this.db) return { settingCount: 0, tenantCount: 0 }

    // Hard cap on boot-time load. Prevents pathological tenant counts from
    // OOMing startup. ~20 settings per tenant means this caps at ~5k tenants.
    const STARTUP_LOAD_LIMIT = 100_000
    const rows = await this.db.query<SettingsRow>({
      query: `SELECT tenant_id, setting_key, setting_value
              FROM logweave.tenant_settings FINAL
              WHERE is_deleted = 0
              LIMIT {limit:UInt32}`,
      query_params: { limit: STARTUP_LOAD_LIMIT },
    })

    for (const row of rows) {
      const existing = this.settings.get(row.tenant_id) ?? {}
      if (row.setting_key === 'slackWebhookUrl') {
        // Stored encrypted; plaintext rows (pre-encryption) pass through unchanged.
        try {
          existing.slackWebhookUrl = await decrypt(row.setting_value, this.encryptionKey)
        } catch (err) {
          // Don't crash startup over one undecryptable webhook — log and skip it.
          this.logger?.warn(
            { err, tenantId: row.tenant_id },
            'Failed to decrypt slackWebhookUrl; Slack alerts disabled for this tenant until re-saved',
          )
        }
      } else if (row.setting_key === 'lastTestStatus') {
        existing.lastTestStatus = row.setting_value as 'success' | 'failed'
      } else if (row.setting_key === 'lastTestAt') {
        existing.lastTestAt = row.setting_value
      } else if (row.setting_key === 'tailMode') {
        existing.tailMode = row.setting_value as TailMode
      } else if (row.setting_key === 'maintenanceUntil') {
        existing.maintenanceUntil = row.setting_value
      } else if (row.setting_key === 'retentionDays') {
        const parsed = Number(row.setting_value)
        if (Number.isFinite(parsed) && parsed > 0) {
          existing.retentionDays = parsed
        }
      } else if (row.setting_key === 'extractTags') {
        try {
          const parsed = JSON.parse(row.setting_value)
          if (Array.isArray(parsed)) {
            existing.extractTags = parsed.filter((t): t is string => typeof t === 'string')
          }
        } catch {
          // ignore malformed JSON
        }
      } else if (row.setting_key === 'lastMcpConnectionAt') {
        existing.lastMcpConnectionAt = row.setting_value
      } else if (row.setting_key === 'onboardingDismissedAt') {
        existing.onboardingDismissedAt = row.setting_value
      } else if (row.setting_key === 'clusteringSensitivity') {
        const parsed = Number(row.setting_value)
        if (Number.isFinite(parsed) && parsed >= 0.2 && parsed <= 0.8) {
          existing.clusteringSensitivity = parsed
        }
      } else if (
        row.setting_key === 'costNoiseDebugPct' ||
        row.setting_key === 'costReviewInfoPct' ||
        row.setting_key === 'costReviewWarnPct'
      ) {
        const parsed = Number(row.setting_value)
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
          existing[row.setting_key] = parsed
        }
      } else if (row.setting_key === 'spikeMinBaseline') {
        const parsed = Number(row.setting_value)
        if (Number.isFinite(parsed) && parsed >= 0) {
          existing.spikeMinBaseline = parsed
        }
      }
      this.settings.set(row.tenant_id, existing)
    }

    const settingCount = rows.length
    const tenantCount = this.settings.size
    this.logger?.info({ settingCount, tenantCount }, 'Loaded tenant settings from ClickHouse')
    return { settingCount, tenantCount }
  }

  /** Get settings for a tenant. Returns empty object if none exist. */
  get(tenantId: string): TenantSettings {
    return this.settings.get(tenantId) ?? {}
  }

  /** Merge partial updates into a tenant's settings. */
  async set(tenantId: string, updates: Partial<TenantSettings>): Promise<void> {
    if (updates.retentionDays !== undefined) {
      if (!Number.isFinite(updates.retentionDays) || updates.retentionDays <= 0) {
        throw new Error('retentionDays must be a positive number')
      }
    }
    for (const key of ['costNoiseDebugPct', 'costReviewInfoPct', 'costReviewWarnPct'] as const) {
      if (updates[key] !== undefined) {
        if (!Number.isFinite(updates[key]) || updates[key] < 0 || updates[key] > 100) {
          throw new Error(`${key} must be a number between 0 and 100`)
        }
      }
    }
    if (updates.spikeMinBaseline !== undefined) {
      if (!Number.isFinite(updates.spikeMinBaseline) || updates.spikeMinBaseline < 0) {
        throw new Error('spikeMinBaseline must be a non-negative number')
      }
    }
    const existing = this.settings.get(tenantId) ?? {}
    const previous = { ...existing }
    this.settings.set(tenantId, { ...existing, ...updates })

    if (this.db) {
      const now = Date.now()
      const rows: {
        tenant_id: string
        setting_key: string
        setting_value: string
        version: number
        is_deleted: number
      }[] = []
      for (const key of SETTING_KEYS) {
        if (key in updates && updates[key] !== undefined) {
          let value = Array.isArray(updates[key])
            ? JSON.stringify(updates[key])
            : String(updates[key])
          // Encrypt the webhook URL at rest (mirrors connector-secret handling);
          // a no-op when no encryption key is configured.
          if (key === 'slackWebhookUrl' && value) {
            value = await encrypt(value, this.encryptionKey)
          }
          rows.push({
            tenant_id: tenantId,
            setting_key: key,
            setting_value: value,
            version: now,
            is_deleted: 0,
          })
        }
      }
      if (rows.length > 0) {
        try {
          await this.db.insert({
            table: 'logweave.tenant_settings',
            values: rows,
            format: 'JSONEachRow',
          })
        } catch (err) {
          this.settings.set(tenantId, previous)
          throw err
        }
      }
    }
  }

  /** Check if tenant is currently in a maintenance window. */
  isInMaintenance(tenantId: string): boolean {
    const until = this.settings.get(tenantId)?.maintenanceUntil
    if (!until) return false
    return new Date(until).getTime() > Date.now()
  }

  /** Get all tenant IDs with settings. */
  getAllTenantIds(): string[] {
    return [...this.settings.keys()]
  }

  /** Get the Slack webhook URL for a tenant, or undefined if not configured. */
  getSlackUrl(tenantId: string): string | undefined {
    return this.settings.get(tenantId)?.slackWebhookUrl
  }

  /** Remove Slack configuration and test status for a tenant. */
  async clearSlack(tenantId: string): Promise<void> {
    const existing = this.settings.get(tenantId)
    const previous = existing ? { ...existing } : undefined
    if (existing) {
      delete existing.slackWebhookUrl
      delete existing.lastTestStatus
      delete existing.lastTestAt
      if (Object.keys(existing).length === 0) {
        this.settings.delete(tenantId)
      }
    }

    if (this.db) {
      const now = Date.now()
      const slackKeys: (keyof TenantSettings)[] = [
        'slackWebhookUrl',
        'lastTestStatus',
        'lastTestAt',
      ]
      const rows = slackKeys.map((key) => ({
        tenant_id: tenantId,
        setting_key: key,
        setting_value: '',
        version: now,
        is_deleted: 1,
      }))
      try {
        await this.db.insert({
          table: 'logweave.tenant_settings',
          values: rows,
          format: 'JSONEachRow',
        })
      } catch (err) {
        if (previous) {
          this.settings.set(tenantId, previous)
        }
        throw err
      }
    }
  }
}
