import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { isExternalHttpUrl } from '../connectors/safe-fetch.js'
import { queryAlertHistory } from '../db/alert-queries.js'
import type { DbClient } from '../db/client.js'
import { AppError, notFound } from '../errors.js'
import { HttpStatus } from '../http-status.js'
import { recordAuditEvent } from '../lib/audit.js'
import { respond } from '../lib/respond.js'
import { getKeyId, getTenantId, requireAdmin } from '../middleware/auth.js'
import { getClientIp } from '../middleware/client-ip.js'
import { validateBody } from '../middleware/validate.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'
import type {
  AlertRule,
  RuleStore,
  TemplateWatchConfig,
  ThresholdConfig,
} from '../watches/rule-store.js'

export interface RuleDeps {
  ruleStore: RuleStore
  db: DbClient
  logger: pino.Logger
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

/** Accepts webhook URLs (https://) and PagerDuty routing keys (pagerduty://). */
const channelSchema = z
  .string()
  .min(1)
  .refine(
    (s) => {
      if (s.startsWith('pagerduty://')) return s.length > 'pagerduty://'.length
      return s.startsWith('https://')
    },
    { message: 'Channel must be an HTTPS URL or PagerDuty routing key (pagerduty://{key})' },
  )
  // SSRF prevention: a webhook channel is fetched server-side when the rule
  // fires, so reject internal/metadata hosts at create time. PagerDuty channels
  // post to a fixed events.pagerduty.com URL (the value is only a routing key),
  // so they're exempt. The authoritative rebinding/redirect guard is safeFetch
  // at delivery time; this is fast create-time feedback. Allowlist a host with
  // LOGWEAVE_CONNECTOR_ALLOWED_HOSTS for self-hosted internal collectors.
  .refine((s) => s.startsWith('pagerduty://') || isExternalHttpUrl(s), {
    message:
      'Channel host is not allowed: loopback, link-local, and private ranges are blocked ' +
      '(SSRF prevention). Allowlist a host with LOGWEAVE_CONNECTOR_ALLOWED_HOSTS.',
  })

const thresholdConfigSchema = z.object({
  metric: z.enum(['error_count', 'warn_count', 'log_count']),
  service: z.string().min(1).max(128),
  operator: z.enum(['>', '>=', '<', '<=']),
  value: z.number().positive(),
  windowMinutes: z.number().int().min(1).max(60),
  environment: z.string().max(64).optional(),
})

const templateWatchConfigSchema = z.object({
  templateId: z.string().min(1),
  templateText: z.string().max(2000),
})

const createRuleSchema = z.discriminatedUnion('ruleType', [
  z.object({
    name: z.string().min(1).max(256),
    ruleType: z.literal('threshold'),
    enabled: z.boolean().default(true),
    config: thresholdConfigSchema,
    channels: z.array(channelSchema).max(10).default([]),
    cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  }),
  z.object({
    name: z.string().min(1).max(256),
    ruleType: z.literal('template_watch'),
    enabled: z.boolean().default(true),
    config: templateWatchConfigSchema,
    channels: z.array(channelSchema).max(10).default([]),
    cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  }),
])

const updateRuleSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
  config: z.union([thresholdConfigSchema, templateWatchConfigSchema]).optional(),
  channels: z.array(channelSchema).max(10).optional(),
  cooldownMinutes: z.number().int().min(1).max(1440).optional(),
})

const alertQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  ruleId: z.string().optional(),
  service: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

type CreateRuleBody = z.infer<typeof createRuleSchema>
type UpdateRuleBody = z.infer<typeof updateRuleSchema>
type AlertQuery = z.infer<typeof alertQuerySchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeRule(rule: AlertRule) {
  return {
    ruleId: rule.ruleId,
    name: rule.name,
    ruleType: rule.ruleType,
    enabled: rule.enabled,
    config: rule.config,
    channels: rule.channels,
    cooldownMinutes: rule.cooldownMinutes ?? null,
  }
}

function parseJsonObject(
  value: string,
  fallback: Record<string, unknown> | null,
  ctx: { logger: pino.Logger; alertId: string; field: string },
): Record<string, unknown> | null {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    ctx.logger.warn(
      { alertId: ctx.alertId, field: ctx.field },
      'Alert row JSON not an object — using fallback',
    )
    return fallback
  } catch (err) {
    ctx.logger.warn(
      { alertId: ctx.alertId, field: ctx.field, err },
      'Failed to parse alert row JSON — using fallback',
    )
    return fallback
  }
}

function parseJsonArray(
  value: string,
  ctx: { logger: pino.Logger; alertId: string; field: string },
): unknown[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return parsed
    ctx.logger.warn(
      { alertId: ctx.alertId, field: ctx.field },
      'Alert row JSON not an array — using []',
    )
    return []
  } catch (err) {
    ctx.logger.warn(
      { alertId: ctx.alertId, field: ctx.field, err },
      'Failed to parse alert row JSON — using []',
    )
    return []
  }
}

function isThresholdConfig(config: unknown): config is ThresholdConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    'metric' in config &&
    'service' in config &&
    'operator' in config &&
    'value' in config &&
    'windowMinutes' in config
  )
}

function isTemplateWatchConfig(config: unknown): config is TemplateWatchConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    'templateId' in config &&
    'templateText' in config
  )
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function ruleRoutes(deps: RuleDeps): Router {
  const router = Router()

  // Creating, updating and deleting alert rules is admin-only; viewers keep
  // read access to GET /rules and GET /alerts. The guard is applied per write
  // route rather than via `router.use`, because this router is mounted
  // path-less under /v1 — a router-level guard would run for every /v1
  // request, not just these routes (LW-281 F1).

  // POST /rules — create a rule
  router.post('/rules', requireAdmin, validateBody(createRuleSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as CreateRuleBody

      const result = await deps.ruleStore.add({
        tenantId,
        name: body.name,
        ruleType: body.ruleType,
        enabled: body.enabled,
        config: body.config,
        channels: body.channels,
        cooldownMinutes: body.cooldownMinutes,
      })

      if (result === 'limit_exceeded') {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'RULE_LIMIT_EXCEEDED',
          'Maximum rules per tenant exceeded',
        )
      }

      recordAuditEvent(deps, {
        tenantId,
        keyId: getKeyId(res),
        action: 'rule.create',
        sourceIp: getClientIp(req),
        details: JSON.stringify({
          ruleId: result.ruleId,
          name: result.name,
          ruleType: result.ruleType,
        }),
      })

      res.status(HttpStatus.CREATED).json({
        data: serializeRule(result),
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // GET /rules — list all rules for tenant
  router.get('/rules', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const rules = deps.ruleStore.list(tenantId)
      const data = rules.map(serializeRule)

      respond(res, data, { count: data.length })
    } catch (err) {
      next(err)
    }
  })

  // PUT /rules/:id — update a rule
  router.put('/rules/:id', requireAdmin, validateBody(updateRuleSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const ruleId = req.params.id as string
      const body = req.body as UpdateRuleBody

      // Validate config matches existing rule's type
      if (body.config) {
        const existing = deps.ruleStore.get(tenantId, ruleId)
        if (!existing) {
          throw notFound('Rule not found')
        }

        if (existing.ruleType === 'threshold' && !isThresholdConfig(body.config)) {
          throw new AppError(
            HttpStatus.BAD_REQUEST,
            'CONFIG_TYPE_MISMATCH',
            'Config does not match rule type threshold',
          )
        }
        if (existing.ruleType === 'template_watch' && !isTemplateWatchConfig(body.config)) {
          throw new AppError(
            HttpStatus.BAD_REQUEST,
            'CONFIG_TYPE_MISMATCH',
            'Config does not match rule type template_watch',
          )
        }
      }

      const updated = await deps.ruleStore.update(tenantId, ruleId, body)
      if (!updated) {
        throw notFound('Rule not found')
      }

      recordAuditEvent(deps, {
        tenantId,
        keyId: getKeyId(res),
        action: 'rule.update',
        sourceIp: getClientIp(req),
        details: JSON.stringify({ ruleId }),
      })

      respond(res, serializeRule(updated), {})
    } catch (err) {
      next(err)
    }
  })

  // DELETE /rules/:id — delete a rule
  router.delete('/rules/:id', requireAdmin, async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const ruleId = req.params.id as string
      // Only record the audit event when a rule was actually removed — a no-op
      // delete (unknown id) must not forge a deletion entry in the SOC2 audit
      // trail (LW-281 F6).
      const removed = await deps.ruleStore.remove(tenantId, ruleId)
      if (removed) {
        recordAuditEvent(deps, {
          tenantId,
          keyId: getKeyId(res),
          action: 'rule.delete',
          sourceIp: getClientIp(req),
          details: JSON.stringify({ ruleId }),
        })
      }

      res.status(HttpStatus.NO_CONTENT).end()
    } catch (err) {
      next(err)
    }
  })

  // GET /alerts — query alert history
  router.get('/alerts', validateQuery(alertQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<AlertQuery>(req)

      const rows = await queryAlertHistory(deps.db, tenantId, {
        hours: params.hours,
        ruleId: params.ruleId,
        service: params.service,
        limit: params.limit,
      })

      const data = rows.map((r) => ({
        alertId: r.alert_id,
        ruleId: r.rule_id,
        ruleType: r.rule_type,
        ruleName: r.rule_name,
        firedAt: r.fired_at,
        metricValue: r.metric_value,
        thresholdValue: r.threshold_value,
        details: parseJsonObject(r.details, null, {
          logger: deps.logger,
          alertId: r.alert_id,
          field: 'details',
        }),
        channelsNotified: parseJsonArray(r.channels_notified, {
          logger: deps.logger,
          alertId: r.alert_id,
          field: 'channels_notified',
        }),
      }))

      respond(res, data, { count: data.length, hours: params.hours })
    } catch (err) {
      next(err)
    }
  })

  return router
}
