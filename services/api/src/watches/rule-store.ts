import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import { uuidv7 } from '../uuid.js'
import type { ThresholdOperator } from './alert-observer.js'

const DEFAULT_MAX_RULES_PER_TENANT = 50

export interface ThresholdConfig {
  metric: 'error_count' | 'warn_count' | 'log_count'
  service: string
  operator: ThresholdOperator
  value: number
  windowMinutes: number
}

export interface TemplateWatchConfig {
  templateId: string
  templateText: string
}

export interface AlertRule {
  tenantId: string
  ruleId: string
  name: string
  ruleType: 'threshold' | 'template_watch'
  enabled: boolean
  config: ThresholdConfig | TemplateWatchConfig
  channels: string[]
  cooldownMinutes?: number
}

interface AlertRuleRow {
  tenant_id: string
  rule_id: string
  name: string
  rule_type: string
  enabled: number
  config: string
  channels: string
  cooldown_minutes: number
}

export interface RuleStoreOpts {
  db?: DbClient
  logger?: pino.Logger
  maxPerTenant?: number
}

/**
 * Write-through cached store for alert rules.
 *
 * Reads from in-memory Map for speed. Mutations persist to ClickHouse
 * so rules survive server restarts.
 */
export class RuleStore {
  private readonly maxPerTenant: number
  private readonly rules = new Map<string, Map<string, AlertRule>>()
  private readonly db?: DbClient
  private readonly logger?: pino.Logger

  constructor(opts: RuleStoreOpts = {}) {
    this.maxPerTenant = opts.maxPerTenant ?? DEFAULT_MAX_RULES_PER_TENANT
    this.db = opts.db
    this.logger = opts.logger
  }

  /** Load all rules from ClickHouse into memory. Call once at startup. */
  async loadFromDb(): Promise<{ ruleCount: number; tenantCount: number }> {
    if (!this.db) return { ruleCount: 0, tenantCount: 0 }

    const rows = await this.db.query<AlertRuleRow>({
      query: `SELECT tenant_id, rule_id, name, rule_type, enabled, config, channels, cooldown_minutes
              FROM logweave.alert_rules FINAL
              WHERE is_deleted = 0`,
    })

    for (const row of rows) {
      let tenantMap = this.rules.get(row.tenant_id)
      if (!tenantMap) {
        tenantMap = new Map()
        this.rules.set(row.tenant_id, tenantMap)
      }
      if (tenantMap.size >= this.maxPerTenant) {
        this.logger?.warn(
          { tenantId: row.tenant_id, maxPerTenant: this.maxPerTenant },
          'Tenant exceeds rule limit in ClickHouse — skipping excess rules',
        )
        continue
      }
      let config: ThresholdConfig | TemplateWatchConfig
      let channels: string[]
      try {
        config = JSON.parse(row.config)
        channels = JSON.parse(row.channels)
      } catch (parseErr) {
        this.logger?.error(
          { err: parseErr, ruleId: row.rule_id, tenantId: row.tenant_id },
          'Skipping rule with corrupted JSON config',
        )
        continue
      }
      tenantMap.set(row.rule_id, {
        tenantId: row.tenant_id,
        ruleId: row.rule_id,
        name: row.name,
        ruleType: row.rule_type as AlertRule['ruleType'],
        enabled: row.enabled === 1,
        config,
        channels,
        cooldownMinutes: row.cooldown_minutes > 0 ? row.cooldown_minutes : undefined,
      })
    }

    const ruleCount = rows.length
    const tenantCount = this.rules.size
    this.logger?.info({ ruleCount, tenantCount }, 'Loaded alert rules from ClickHouse')
    return { ruleCount, tenantCount }
  }

  /**
   * Add a rule. Generates UUIDv7 for ruleId if not provided.
   * Returns the created rule, or 'limit_exceeded' if the tenant has reached the limit.
   */
  async add(rule: Omit<AlertRule, 'ruleId'> & { ruleId?: string }): Promise<AlertRule | 'limit_exceeded'> {
    let tenantMap = this.rules.get(rule.tenantId)
    if (!tenantMap) {
      tenantMap = new Map()
      this.rules.set(rule.tenantId, tenantMap)
    }
    if (tenantMap.size >= this.maxPerTenant) return 'limit_exceeded'

    const fullRule: AlertRule = {
      ...rule,
      ruleId: rule.ruleId ?? uuidv7(),
    }
    tenantMap.set(fullRule.ruleId, fullRule)

    if (this.db) {
      try {
        await this.persistRule(fullRule, 0)
      } catch (err) {
        tenantMap.delete(fullRule.ruleId)
        if (tenantMap.size === 0) this.rules.delete(rule.tenantId)
        throw err
      }
    }

    return fullRule
  }

  /** Update a rule. Returns the updated rule, or undefined if not found. */
  async update(
    tenantId: string,
    ruleId: string,
    updates: Partial<Pick<AlertRule, 'name' | 'enabled' | 'config' | 'channels' | 'cooldownMinutes'>>,
  ): Promise<AlertRule | undefined> {
    const tenantMap = this.rules.get(tenantId)
    if (!tenantMap) return undefined
    const existing = tenantMap.get(ruleId)
    if (!existing) return undefined

    const updated: AlertRule = {
      ...existing,
      ...updates,
    }
    tenantMap.set(ruleId, updated)

    if (this.db) {
      try {
        await this.persistRule(updated, 0)
      } catch (err) {
        // Rollback
        tenantMap.set(ruleId, existing)
        throw err
      }
    }

    return updated
  }

  /** Remove a rule. Returns true if it was present. */
  async remove(tenantId: string, ruleId: string): Promise<boolean> {
    const tenantMap = this.rules.get(tenantId)
    if (!tenantMap) return false
    const existing = tenantMap.get(ruleId)
    if (!existing) return false

    tenantMap.delete(ruleId)
    if (tenantMap.size === 0) this.rules.delete(tenantId)

    if (this.db) {
      try {
        await this.db.insert({
          table: 'logweave.alert_rules',
          values: [
            {
              tenant_id: tenantId,
              rule_id: ruleId,
              name: '',
              rule_type: '',
              enabled: 0,
              config: '',
              channels: '[]',
              version: Date.now(),
              is_deleted: 1,
            },
          ],
          format: 'JSONEachRow',
        })
      } catch (err) {
        // Rollback
        let restored = this.rules.get(tenantId)
        if (!restored) {
          restored = new Map()
          this.rules.set(tenantId, restored)
        }
        restored.set(ruleId, existing)
        throw err
      }
    }

    return true
  }

  /** Get a single rule. */
  get(tenantId: string, ruleId: string): AlertRule | undefined {
    return this.rules.get(tenantId)?.get(ruleId)
  }

  /** List all rules for a tenant (sorted by ruleId). */
  list(tenantId: string): AlertRule[] {
    const tenantMap = this.rules.get(tenantId)
    if (!tenantMap) return []
    return [...tenantMap.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId))
  }

  /** Get all enabled rules of a given type across all tenants. */
  getEnabledByType(ruleType: 'threshold' | 'template_watch'): AlertRule[] {
    const result: AlertRule[] = []
    for (const tenantMap of this.rules.values()) {
      for (const rule of tenantMap.values()) {
        if (rule.ruleType === ruleType && rule.enabled) {
          result.push(rule)
        }
      }
    }
    return result
  }

  private async persistRule(rule: AlertRule, isDeleted: number): Promise<void> {
    if (!this.db) return
    await this.db.insert({
      table: 'logweave.alert_rules',
      values: [
        {
          tenant_id: rule.tenantId,
          rule_id: rule.ruleId,
          name: rule.name,
          rule_type: rule.ruleType,
          enabled: rule.enabled ? 1 : 0,
          config: JSON.stringify(rule.config),
          channels: JSON.stringify(rule.channels),
          cooldown_minutes: rule.cooldownMinutes ?? 0,
          version: Date.now(),
          is_deleted: isDeleted,
        },
      ],
      format: 'JSONEachRow',
    })
  }
}
