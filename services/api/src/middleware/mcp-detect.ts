import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type pino from 'pino'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'
import { getTenantId } from './auth.js'

const MCP_USER_AGENT = '@logweave/mcp'

export interface McpDetectDeps {
  settingsStore: TenantSettingsStore
  logger: pino.Logger
}

/**
 * Post-auth middleware that detects MCP server connections via User-Agent.
 * On first detection per tenant, stamps `lastMcpConnectionAt` in settings.
 * Runs on every authenticated request but only writes once (in-memory check).
 */
export function createMcpDetectMiddleware(deps: McpDetectDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ua = req.get('user-agent') ?? ''
    if (!ua.includes(MCP_USER_AGENT)) {
      next()
      return
    }

    const tenantId = getTenantId(res)
    const settings = deps.settingsStore.get(tenantId)

    if (settings.lastMcpConnectionAt) {
      next()
      return
    }

    const now = new Date().toISOString()
    deps.settingsStore.set(tenantId, { lastMcpConnectionAt: now }).catch((err) => {
      deps.logger.error({ err, tenantId }, 'Failed to persist MCP connection timestamp')
    })

    next()
  }
}
