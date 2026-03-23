import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { queryAlertHistory } from '../db/alert-queries.js'
import type { DbClient } from '../db/client.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
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

const thresholdConfigSchema = z.object({
  metric: z.enum(['error_count', 'warn_count', 'log_count']),
  service: z.string().min(1).max(128),
  operator: z.enum(['>', '>=', '<', '<=']),
  value: z.number().positive(),
  windowMinutes: z.number().int().min(1).max(60),
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
    channels: z.array(z.string().url()).max(10).default([]),
  }),
  z.object({
    name: z.string().min(1).max(256),
    ruleType: z.literal('template_watch'),
    enabled: z.boolean().default(true),
    config: templateWatchConfigSchema,
    channels: z.array(z.string().url()).max(10).default([]),
  }),
])

const updateRuleSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
  config: z.union([thresholdConfigSchema, templateWatchConfigSchema]).optional(),
  channels: z.array(z.string().url()).max(10).optional(),
})

const alertQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  rule_id: z.string().optional(),
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
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
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

  // POST /rules — create a rule
  router.post('/rules', validateBody(createRuleSchema), async (req, res, next) => {
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
      })

      if (result === 'limit_exceeded') {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: { code: 'RULE_LIMIT_EXCEEDED', message: 'Maximum rules per tenant exceeded' },
        })
        return
      }

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

      res.status(HttpStatus.OK).json({
        data,
        meta: { count: data.length, fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // PUT /rules/:id — update a rule
  router.put('/rules/:id', validateBody(updateRuleSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const ruleId = req.params.id as string
      const body = req.body as UpdateRuleBody

      // Validate config matches existing rule's type
      if (body.config) {
        const existing = deps.ruleStore.get(tenantId, ruleId)
        if (!existing) {
          res.status(HttpStatus.NOT_FOUND).json({
            error: { code: 'NOT_FOUND', message: 'Rule not found' },
          })
          return
        }

        if (existing.ruleType === 'threshold' && !isThresholdConfig(body.config)) {
          res.status(HttpStatus.BAD_REQUEST).json({
            error: {
              code: 'CONFIG_TYPE_MISMATCH',
              message: 'Config does not match rule type threshold',
            },
          })
          return
        }
        if (existing.ruleType === 'template_watch' && !isTemplateWatchConfig(body.config)) {
          res.status(HttpStatus.BAD_REQUEST).json({
            error: {
              code: 'CONFIG_TYPE_MISMATCH',
              message: 'Config does not match rule type template_watch',
            },
          })
          return
        }
      }

      const updated = await deps.ruleStore.update(tenantId, ruleId, body)
      if (!updated) {
        res.status(HttpStatus.NOT_FOUND).json({
          error: { code: 'NOT_FOUND', message: 'Rule not found' },
        })
        return
      }

      res.status(HttpStatus.OK).json({
        data: serializeRule(updated),
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // DELETE /rules/:id — delete a rule
  router.delete('/rules/:id', async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const ruleId = req.params.id as string
      await deps.ruleStore.remove(tenantId, ruleId)
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
        ruleId: params.rule_id,
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
        details: safeJsonParse(r.details),
        channelsNotified: safeJsonParse(r.channels_notified),
      }))

      res.status(HttpStatus.OK).json({
        data,
        meta: { count: data.length, hours: params.hours, fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
