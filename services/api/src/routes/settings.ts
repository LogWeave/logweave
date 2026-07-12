import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import type { DbClient } from '../db/client.js'
import { AppError } from '../errors.js'
import { HttpStatus } from '../http-status.js'
import { respond } from '../lib/respond.js'
import { getTenantId, requireAdmin } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'
import { sendSlackTestMessage } from '../watches/slack-observer.js'
import type { TenantSettings, TenantSettingsStore } from '../watches/tenant-settings.js'

export interface SettingsDeps {
  settingsStore: TenantSettingsStore
  db: DbClient | null
  clusterClient?: ClusterClient
  logger: pino.Logger
}

const slackWebhookSchema = z.object({
  webhookUrl: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://hooks.slack.com/'), {
      message: 'Webhook URL must start with https://hooks.slack.com/',
    }),
})

export function settingsRoutes(deps: SettingsDeps): Router {
  const router = Router()

  // State-changing settings (Slack webhook, clustering, tags, cost thresholds,
  // …) are admin-only; viewers keep read access to the GET routes. The guard is
  // applied per write route rather than via `router.use`, because this router is
  // mounted path-less under /v1 — a router-level guard would run for every /v1
  // request, not just these routes.

  // GET /settings/slack -- returns config status (never exposes the URL)
  router.get('/settings/slack', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      respond(res, {
        configured: settings.slackWebhookUrl !== undefined,
        lastTestStatus: settings.lastTestStatus ?? null,
        lastTestAt: settings.lastTestAt ?? null,
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /settings/slack -- store webhook URL
  router.post(
    '/settings/slack',
    requireAdmin,
    validateBody(slackWebhookSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof slackWebhookSchema>

        await deps.settingsStore.set(tenantId, { slackWebhookUrl: body.webhookUrl })
        deps.logger.info({ tenantId }, 'Slack webhook configured')

        respond(res, { configured: true })
      } catch (err) {
        next(err)
      }
    },
  )

  // DELETE /settings/slack -- remove webhook config
  router.delete('/settings/slack', requireAdmin, async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      await deps.settingsStore.clearSlack(tenantId)
      deps.logger.info({ tenantId }, 'Slack webhook removed')

      res.status(HttpStatus.NO_CONTENT).end()
    } catch (err) {
      next(err)
    }
  })

  // GET /settings/tags -- returns configured tag extraction keys
  router.get('/settings/tags', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      respond(res, { extractTags: settings.extractTags ?? [] })
    } catch (err) {
      next(err)
    }
  })

  // PUT /settings/tags -- update tag extraction keys
  const BLOCKED_TAG_KEYS = new Set(['message', 'msg', 'log', 'body', 'raw', 'text', 'content'])
  const extractTagsSchema = z.object({
    extractTags: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_.-]+$/, 'Tag keys must be alphanumeric with _ . -')
          .refine(
            (k) => !BLOCKED_TAG_KEYS.has(k.toLowerCase()),
            'This field name is reserved and cannot be used as a tag key',
          ),
      )
      .max(20, 'Maximum 20 tag keys'),
  })

  router.put(
    '/settings/tags',
    requireAdmin,
    validateBody(extractTagsSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof extractTagsSchema>

        await deps.settingsStore.set(tenantId, { extractTags: body.extractTags })
        deps.logger.info(
          { tenantId, tagCount: body.extractTags.length },
          'Tag extraction keys updated',
        )

        respond(res, { extractTags: body.extractTags })
      } catch (err) {
        next(err)
      }
    },
  )

  // GET /settings/onboarding-status -- lightweight onboarding progress check
  router.get('/settings/onboarding-status', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      let hasEvents = false
      if (deps.db) {
        // Bound to last 24h so partition pruning kicks in. Onboarding cares
        // about "have you ingested anything recently?", not lifetime history.
        const rows = await deps.db.query<{ has_data: number }>({
          query: `SELECT 1 AS has_data
                  FROM logweave.log_metadata
                  WHERE tenant_id = {tenantId:String}
                    AND timestamp > now64(3) - toIntervalDay(1)
                  LIMIT 1`,
          query_params: { tenantId },
        })
        hasEvents = rows.length > 0
      }

      respond(res, {
        hasEvents,
        mcpConnected: settings.lastMcpConnectionAt !== undefined,
        clusteringConfigured: settings.clusteringSensitivity !== undefined,
        dismissed: settings.onboardingDismissedAt !== undefined,
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /settings/onboarding/dismiss -- mark onboarding as dismissed
  router.post('/settings/onboarding/dismiss', requireAdmin, async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      if (!settings.onboardingDismissedAt) {
        await deps.settingsStore.set(tenantId, {
          onboardingDismissedAt: new Date().toISOString(),
        })
        deps.logger.info({ tenantId }, 'Onboarding dismissed')
      }

      respond(res, { dismissed: true })
    } catch (err) {
      next(err)
    }
  })

  // PUT /settings/clustering -- update clustering sensitivity
  const clusteringSchema = z.object({
    sensitivity: z.number().min(0.2).max(0.8),
  })

  router.put(
    '/settings/clustering',
    requireAdmin,
    validateBody(clusteringSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof clusteringSchema>

        await deps.settingsStore.set(tenantId, { clusteringSensitivity: body.sensitivity })
        deps.logger.info(
          { tenantId, sensitivity: body.sensitivity },
          'Clustering sensitivity updated',
        )

        respond(res, { sensitivity: body.sensitivity })
      } catch (err) {
        next(err)
      }
    },
  )

  // GET /settings/clustering -- get current clustering sensitivity
  router.get('/settings/clustering', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      respond(res, { sensitivity: settings.clusteringSensitivity ?? null })
    } catch (err) {
      next(err)
    }
  })

  // POST /settings/clustering/preview -- dry-run clustering on recent logs
  const previewSchema = z.object({
    sensitivity: z.number().min(0.2).max(0.8),
  })

  router.post(
    '/settings/clustering/preview',
    requireAdmin,
    validateBody(previewSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof previewSchema>

        if (!deps.clusterClient || !deps.db) {
          respond(
            res,
            { patternCount: 0, compressionRatio: 0, sampleTemplates: [] },
            {
              message: 'Preview unavailable — clusterer not connected',
            },
          )
          return
        }

        // Fetch recent pre-processed messages from ClickHouse. Bound to last 7
        // days so the ORDER BY DESC doesn't pay to sort the full 30-day partition.
        const rows = await deps.db.query<{ pre_processed_message: string }>({
          query: `SELECT pre_processed_message
                FROM logweave.log_metadata
                WHERE tenant_id = {tenantId:String}
                  AND pre_processed_message != ''
                  AND timestamp > now64(3) - toIntervalDay(7)
                ORDER BY timestamp DESC
                LIMIT 1000`,
          query_params: { tenantId },
        })

        if (rows.length === 0) {
          respond(
            res,
            { patternCount: 0, compressionRatio: 0, sampleTemplates: [] },
            {
              message: 'No log data to preview — send some logs first',
            },
          )
          return
        }

        const messages = rows.map((r) => r.pre_processed_message)
        const result = await deps.clusterClient.preview(messages, body.sensitivity)

        if (!result) {
          respond(
            res,
            { patternCount: 0, compressionRatio: 0, sampleTemplates: [] },
            {
              message: 'Clusterer preview failed — try again later',
            },
          )
          return
        }

        respond(res, result, { sampleSize: messages.length })
      } catch (err) {
        next(err)
      }
    },
  )

  // POST /settings/clustering/reset -- clear tenant's Drain3 miner and update sensitivity
  const resetSchema = z.object({
    sensitivity: z.number().min(0.2).max(0.8),
  })

  router.post(
    '/settings/clustering/reset',
    requireAdmin,
    validateBody(resetSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof resetSchema>

        await deps.settingsStore.set(tenantId, { clusteringSensitivity: body.sensitivity })

        let cleared = false
        if (deps.clusterClient) {
          cleared = await deps.clusterClient.resetTenant(tenantId)
        }

        deps.logger.info({ tenantId, sensitivity: body.sensitivity, cleared }, 'Clustering reset')

        respond(res, { sensitivity: body.sensitivity, cleared })
      } catch (err) {
        next(err)
      }
    },
  )

  // GET /settings/cost-thresholds -- returns cost optimizer thresholds or defaults
  router.get('/settings/cost-thresholds', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      respond(res, {
        noiseDebugPct: settings.costNoiseDebugPct ?? 5,
        reviewInfoPct: settings.costReviewInfoPct ?? 10,
        reviewWarnPct: settings.costReviewWarnPct ?? 20,
        isCustom:
          settings.costNoiseDebugPct !== undefined ||
          settings.costReviewInfoPct !== undefined ||
          settings.costReviewWarnPct !== undefined,
      })
    } catch (err) {
      next(err)
    }
  })

  // PUT /settings/cost-thresholds -- update cost optimizer thresholds
  const costThresholdsSchema = z.object({
    noiseDebugPct: z.number().min(0).max(100).optional(),
    reviewInfoPct: z.number().min(0).max(100).optional(),
    reviewWarnPct: z.number().min(0).max(100).optional(),
  })

  router.put(
    '/settings/cost-thresholds',
    requireAdmin,
    validateBody(costThresholdsSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof costThresholdsSchema>

        const updates: Partial<TenantSettings> = {}
        if (body.noiseDebugPct !== undefined) updates.costNoiseDebugPct = body.noiseDebugPct
        if (body.reviewInfoPct !== undefined) updates.costReviewInfoPct = body.reviewInfoPct
        if (body.reviewWarnPct !== undefined) updates.costReviewWarnPct = body.reviewWarnPct

        await deps.settingsStore.set(tenantId, updates)
        deps.logger.info({ tenantId, ...updates }, 'Cost optimizer thresholds updated')

        const settings = deps.settingsStore.get(tenantId)
        respond(res, {
          noiseDebugPct: settings.costNoiseDebugPct ?? 5,
          reviewInfoPct: settings.costReviewInfoPct ?? 10,
          reviewWarnPct: settings.costReviewWarnPct ?? 20,
          isCustom: true,
        })
      } catch (err) {
        next(err)
      }
    },
  )

  // POST /settings/slack/test -- send test message
  router.post('/settings/slack/test', requireAdmin, async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const webhookUrl = deps.settingsStore.getSlackUrl(tenantId)

      if (!webhookUrl) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'SLACK_NOT_CONFIGURED',
          'No Slack webhook URL configured. Use POST /v1/settings/slack first.',
        )
      }

      const result = await sendSlackTestMessage(webhookUrl)

      await deps.settingsStore.set(tenantId, {
        lastTestStatus: result.success ? 'success' : 'failed',
        lastTestAt: new Date().toISOString(),
      })

      respond(res, {
        success: result.success,
        ...(result.error ? { failureReason: result.error } : {}),
      })
    } catch (err) {
      next(err)
    }
  })

  // GET /settings/spike-baseline -- returns spike minimum baseline or default
  router.get('/settings/spike-baseline', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)
      respond(res, {
        minBaseline: settings.spikeMinBaseline ?? 10,
        isCustom: settings.spikeMinBaseline !== undefined,
      })
    } catch (err) {
      next(err)
    }
  })

  // PUT /settings/spike-baseline -- update spike minimum baseline
  const spikeBaselineSchema = z.object({
    minBaseline: z.number().int().min(0).max(10_000),
  })

  router.put(
    '/settings/spike-baseline',
    requireAdmin,
    validateBody(spikeBaselineSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof spikeBaselineSchema>
        await deps.settingsStore.set(tenantId, { spikeMinBaseline: body.minBaseline })
        deps.logger.info(
          { tenantId, spikeMinBaseline: body.minBaseline },
          'Spike min baseline updated',
        )
        respond(res, { minBaseline: body.minBaseline, isCustom: true })
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}
