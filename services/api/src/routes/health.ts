import { Router } from 'express'
import { pingClickHouse } from '../clients/clickhouse.js'
import type { ClustererHealthChecker } from '../clients/clusterer.js'
import { HttpStatus } from '../http-status.js'
import type { ClickHouseClient } from '../types.js'

interface HealthDeps {
  clickhouse: ClickHouseClient
  clustererHealth: ClustererHealthChecker
}

const READY_CACHE_TTL_MS = 5_000
let readyCache: { ok: boolean; ts: number } = { ok: false, ts: 0 }

export function healthRoutes(deps: HealthDeps): Router {
  const router = Router()

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' })
  })

  router.get('/readyz', async (_req, res) => {
    const now = Date.now()

    // Use cached result if fresh
    if (readyCache.ok && now - readyCache.ts < READY_CACHE_TTL_MS) {
      res.json({
        status: 'ready',
        clickhouse: 'ok',
        clusterer: {
          status: deps.clustererHealth.consecutiveFailures === 0 ? 'ok' : 'degraded',
          consecutiveFailures: deps.clustererHealth.consecutiveFailures,
        },
      })
      return
    }

    const chOk = await pingClickHouse(deps.clickhouse)
    readyCache = { ok: chOk, ts: now }

    const clustererStatus = deps.clustererHealth.consecutiveFailures === 0 ? 'ok' : 'degraded'

    if (!chOk) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'not_ready',
        clickhouse: 'error',
        clusterer: {
          status: clustererStatus,
          consecutiveFailures: deps.clustererHealth.consecutiveFailures,
        },
      })
      return
    }

    res.json({
      status: 'ready',
      clickhouse: 'ok',
      clusterer: {
        status: clustererStatus,
        consecutiveFailures: deps.clustererHealth.consecutiveFailures,
      },
    })
  })

  return router
}

/** Reset cache — for testing only */
export function _resetReadyCache(): void {
  readyCache = { ok: false, ts: 0 }
}
