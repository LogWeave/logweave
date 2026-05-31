import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { ApiKeyLimitError, type ApiKeyStore } from '../auth/api-key-store.js'
import { insertAuditEvent } from '../db/audit-queries.js'
import type { DbClient } from '../db/client.js'
import { notFound, validationError } from '../errors.js'
import { HttpStatus } from '../http-status.js'
import { respond } from '../lib/respond.js'
import { getKeyId, getTenantId, requireAdmin } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'

export interface ApiKeyRoutesDeps {
  db: DbClient
  logger: pino.Logger
  apiKeyStore: ApiKeyStore
}

const createKeySchema = z.object({
  name: z.string().min(1).max(128),
})

/**
 * Per-tenant API key management. Admin-only.
 *
 * Service-token semantics (not personal access tokens):
 * - keys belong to a tenant, not a user
 * - `createdBy` is audit metadata, not ownership
 * - revocation is tenant-scoped: tenant A's admin cannot revoke tenant B's key
 *
 * Show-once contract: POST returns the raw key in the response. After that,
 * only the hash is stored and only the prefix is ever returned.
 */
export function apiKeyRoutes(deps: ApiKeyRoutesDeps): Router {
  const router = Router()

  router.use(requireAdmin)

  // POST /api-keys — create a new key. Returns the raw key once.
  router.post('/api-keys', validateBody(createKeySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const createdBy = getKeyId(res)
      const body = req.body as z.infer<typeof createKeySchema>

      const { key, rawKey } = await deps.apiKeyStore.create({
        tenantId,
        name: body.name,
        createdBy,
      })

      // Audit trail. Never include the raw key or its full hash.
      insertAuditEvent(deps.db, tenantId, {
        keyId: createdBy,
        action: 'api_key.create',
        details: JSON.stringify({ keyId: key.keyId, name: key.name, prefix: key.prefix }),
      }).catch((err) =>
        deps.logger.warn({ err, keyId: key.keyId }, 'api_key.create audit insert failed'),
      )

      res.status(HttpStatus.CREATED).json({
        data: {
          ...key,
          // Raw key is in the response exactly once — caller must capture it.
          key: rawKey,
        },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      if (err instanceof ApiKeyLimitError) {
        next(validationError(err.message))
        return
      }
      next(err)
    }
  })

  // GET /api-keys — list active keys for the tenant. No raw key, no hash.
  router.get('/api-keys', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const keys = await deps.apiKeyStore.list(tenantId)
      respond(res, keys, { count: keys.length })
    } catch (err) {
      next(err)
    }
  })

  // DELETE /api-keys/:keyId — revoke. Tenant-scoped — the store enforces this.
  router.delete('/api-keys/:keyId', async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const revokedBy = getKeyId(res)
      const keyId = req.params.keyId as string

      const ok = await deps.apiKeyStore.revoke({ tenantId, keyId, revokedBy })
      if (!ok) {
        throw notFound('Key not found')
      }

      insertAuditEvent(deps.db, tenantId, {
        keyId: revokedBy,
        action: 'api_key.revoke',
        details: JSON.stringify({ revokedKeyId: keyId }),
      }).catch((err) => deps.logger.warn({ err, keyId }, 'api_key.revoke audit insert failed'))

      res.status(HttpStatus.NO_CONTENT).end()
    } catch (err) {
      next(err)
    }
  })

  return router
}
