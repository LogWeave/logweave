import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import type { DbClient } from '../db/client.js'
import { queryEventsByTag } from '../db/tag-queries.js'
import { respond } from '../lib/respond.js'
import { getTenantId } from '../middleware/auth.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'

export interface TagDeps {
  db: DbClient
  logger: pino.Logger
}

const tagQuerySchema = z.object({
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(256),
  hours: z.coerce.number().int().min(1).max(720).default(24),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

type TagQuery = z.infer<typeof tagQuerySchema>

export function tagRoutes(deps: TagDeps): Router {
  const router = Router()

  router.get('/events/by-tag', validateQuery(tagQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<TagQuery>(req)

      const rows = await queryEventsByTag(deps.db, tenantId, {
        key: params.key,
        value: params.value,
        hours: params.hours,
        limit: params.limit,
      })

      const data = rows.map((r) => ({
        eventId: r.event_id,
        templateId: r.template_id,
        service: r.service,
        level: r.level,
        timestamp: r.timestamp,
        tagKey: r.tag_key,
        tagValue: r.tag_value,
      }))

      respond(res, data, { hours: params.hours, count: data.length })
    } catch (err) {
      next(err)
    }
  })

  return router
}
