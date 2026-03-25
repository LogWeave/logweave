import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import type { DbClient } from '../db/client.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'
import { sendSlackTestMessage } from '../watches/slack-observer.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'

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

  // GET /settings/slack -- returns config status (never exposes the URL)
  router.get('/settings/slack', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      res.status(HttpStatus.OK).json({
        data: {
          configured: settings.slackWebhookUrl !== undefined,
          lastTestStatus: settings.lastTestStatus ?? null,
          lastTestAt: settings.lastTestAt ?? null,
        },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /settings/slack -- store webhook URL
  router.post('/settings/slack', validateBody(slackWebhookSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof slackWebhookSchema>

      await deps.settingsStore.set(tenantId, { slackWebhookUrl: body.webhookUrl })
      deps.logger.info({ tenantId }, 'Slack webhook configured')

      res.status(HttpStatus.OK).json({
        data: { configured: true },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // DELETE /settings/slack -- remove webhook config
  router.delete('/settings/slack', async (_req, res, next) => {
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

      res.status(HttpStatus.OK).json({
        data: { extractTags: settings.extractTags ?? [] },
        meta: { fetchedAt: new Date().toISOString() },
      })
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
          .refine((k) => !BLOCKED_TAG_KEYS.has(k.toLowerCase()), 'This field name is reserved and cannot be used as a tag key'),
      )
      .max(20, 'Maximum 20 tag keys'),
  })

  router.put('/settings/tags', validateBody(extractTagsSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof extractTagsSchema>

      await deps.settingsStore.set(tenantId, { extractTags: body.extractTags })
      deps.logger.info({ tenantId, tagCount: body.extractTags.length }, 'Tag extraction keys updated')

      res.status(HttpStatus.OK).json({
        data: { extractTags: body.extractTags },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // GET /settings/onboarding-status -- lightweight onboarding progress check
  router.get('/settings/onboarding-status', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      let hasEvents = false
      if (deps.db) {
        const rows = await deps.db.query<{ has_data: number }>({
          query: `SELECT 1 AS has_data
                  FROM logweave.log_metadata
                  WHERE tenant_id = {tenantId:String}
                  LIMIT 1`,
          query_params: { tenantId },
        })
        hasEvents = rows.length > 0
      }

      res.status(HttpStatus.OK).json({
        data: {
          hasEvents,
          mcpConnected: settings.lastMcpConnectionAt !== undefined,
          clusteringConfigured: settings.clusteringSensitivity !== undefined,
          dismissed: settings.onboardingDismissedAt !== undefined,
        },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /settings/onboarding/dismiss -- mark onboarding as dismissed
  router.post('/settings/onboarding/dismiss', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      if (!settings.onboardingDismissedAt) {
        await deps.settingsStore.set(tenantId, {
          onboardingDismissedAt: new Date().toISOString(),
        })
        deps.logger.info({ tenantId }, 'Onboarding dismissed')
      }

      res.status(HttpStatus.OK).json({
        data: { dismissed: true },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // PUT /settings/clustering -- update clustering sensitivity
  const clusteringSchema = z.object({
    sensitivity: z.number().min(0.2).max(0.8),
  })

  router.put('/settings/clustering', validateBody(clusteringSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof clusteringSchema>

      await deps.settingsStore.set(tenantId, { clusteringSensitivity: body.sensitivity })
      deps.logger.info({ tenantId, sensitivity: body.sensitivity }, 'Clustering sensitivity updated')

      res.status(HttpStatus.OK).json({
        data: { sensitivity: body.sensitivity },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // GET /settings/clustering -- get current clustering sensitivity
  router.get('/settings/clustering', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const settings = deps.settingsStore.get(tenantId)

      res.status(HttpStatus.OK).json({
        data: { sensitivity: settings.clusteringSensitivity ?? null },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /settings/clustering/preview -- dry-run clustering on recent logs
  const previewSchema = z.object({
    sensitivity: z.number().min(0.2).max(0.8),
  })

  router.post('/settings/clustering/preview', validateBody(previewSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof previewSchema>

      if (!deps.clusterClient || !deps.db) {
        res.status(HttpStatus.OK).json({
          data: { patternCount: 0, compressionRatio: 0, sampleTemplates: [] },
          meta: { fetchedAt: new Date().toISOString(), message: 'Preview unavailable — clusterer not connected' },
        })
        return
      }

      // Fetch recent pre-processed messages from ClickHouse
      const rows = await deps.db.query<{ pre_processed_message: string }>({
        query: `SELECT pre_processed_message
                FROM logweave.log_metadata
                WHERE tenant_id = {tenantId:String}
                  AND pre_processed_message != ''
                ORDER BY timestamp DESC
                LIMIT 1000`,
        query_params: { tenantId },
      })

      if (rows.length === 0) {
        res.status(HttpStatus.OK).json({
          data: { patternCount: 0, compressionRatio: 0, sampleTemplates: [] },
          meta: { fetchedAt: new Date().toISOString(), message: 'No log data to preview — send some logs first' },
        })
        return
      }

      const messages = rows.map((r) => r.pre_processed_message)
      const result = await deps.clusterClient.preview(messages, body.sensitivity)

      if (!result) {
        res.status(HttpStatus.OK).json({
          data: { patternCount: 0, compressionRatio: 0, sampleTemplates: [] },
          meta: { fetchedAt: new Date().toISOString(), message: 'Clusterer preview failed — try again later' },
        })
        return
      }

      res.status(HttpStatus.OK).json({
        data: result,
        meta: { fetchedAt: new Date().toISOString(), sampleSize: messages.length },
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /settings/clustering/reset -- clear tenant's Drain3 miner and update sensitivity
  const resetSchema = z.object({
    sensitivity: z.number().min(0.2).max(0.8),
  })

  router.post('/settings/clustering/reset', validateBody(resetSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof resetSchema>

      await deps.settingsStore.set(tenantId, { clusteringSensitivity: body.sensitivity })

      let cleared = false
      if (deps.clusterClient) {
        cleared = await deps.clusterClient.resetTenant(tenantId)
      }

      deps.logger.info({ tenantId, sensitivity: body.sensitivity, cleared }, 'Clustering reset')

      res.status(HttpStatus.OK).json({
        data: { sensitivity: body.sensitivity, cleared },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /settings/slack/test -- send test message
  router.post('/settings/slack/test', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const webhookUrl = deps.settingsStore.getSlackUrl(tenantId)

      if (!webhookUrl) {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: {
            code: 'SLACK_NOT_CONFIGURED',
            message: 'No Slack webhook URL configured. Use POST /v1/settings/slack first.',
          },
        })
        return
      }

      const result = await sendSlackTestMessage(webhookUrl)

      await deps.settingsStore.set(tenantId, {
        lastTestStatus: result.success ? 'success' : 'failed',
        lastTestAt: new Date().toISOString(),
      })

      res.status(HttpStatus.OK).json({
        data: {
          success: result.success,
          ...(result.error ? { error: result.error } : {}),
        },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
