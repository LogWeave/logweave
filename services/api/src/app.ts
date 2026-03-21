import { existsSync } from 'node:fs'
import path from 'node:path'
import express, { Router } from 'express'
import helmet from 'helmet'
import type pino from 'pino'
import { type Options as PinoHttpOptions, pinoHttp } from 'pino-http'
import type { ClustererHealthChecker } from './clients/clusterer.js'
import type { Config } from './config.js'
import type { DbClient } from './db/client.js'
import { notFound } from './errors.js'
import { requestContext } from './logger.js'
import { createAuthMiddleware } from './middleware/auth.js'
import { createConcurrentQueryGuard } from './middleware/concurrent-query-guard.js'
import { createErrorHandler } from './middleware/error-handler.js'
import { createRateLimiter } from './middleware/rate-limit.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import type { AnomalyScorer } from './pipeline/anomaly-scorer.js'
import type { ClusterClient } from './pipeline/cluster-client.js'
import { correlationRoutes } from './routes/correlation.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { deployRoutes } from './routes/deploys.js'
import { healthRoutes } from './routes/health.js'
import { ingestRoutes } from './routes/ingest.js'
import { settingsRoutes } from './routes/settings.js'
import { watchRoutes } from './routes/watches.js'
import type { TenantSettingsStore } from './watches/tenant-settings.js'
import type { WatchStore } from './watches/watch-store.js'

export interface AppDependencies {
  config: Config
  logger: pino.Logger
  db: DbClient
  clustererHealth: ClustererHealthChecker
  clusterClient: ClusterClient
  anomalyScorer: AnomalyScorer
  watchStore: WatchStore
  settingsStore: TenantSettingsStore
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express()
  app.disable('x-powered-by')

  // Request-id middleware (must be first — sets up AsyncLocalStorage context)
  app.use(requestIdMiddleware)

  // Security headers — CSP disabled until Week 2 dashboard defines its requirements
  app.use(helmet({ contentSecurityPolicy: false }))

  // Structured request logging (skip health probes)
  const httpLoggerOpts: PinoHttpOptions = {
    logger: deps.logger,
    autoLogging: {
      ignore(req) {
        const url = req.url ?? ''
        return url === '/healthz' || url === '/readyz'
      },
    },
    genReqId(req) {
      const store = requestContext.getStore()
      if (store) return store.requestId
      const header = req.headers['x-request-id']
      return (Array.isArray(header) ? header[0] : header) ?? 'unknown'
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          headers: {
            ...req.raw?.headers,
            authorization: req.raw?.headers?.authorization ? '[REDACTED]' : undefined,
          },
        }
      },
    },
  }
  app.use(pinoHttp(httpLoggerOpts))

  // Body parsing
  app.use(express.json({ limit: '1mb' }))

  // Routes — health (unauthenticated)
  app.use(
    healthRoutes({
      db: deps.db,
      clustererHealth: deps.clustererHealth,
      clusterClient: deps.clusterClient,
    }),
  )

  // Routes — API (authenticated, rate-limited)
  const auth = createAuthMiddleware(deps.config.apiKeys)
  deps.config.apiKeys.clear() // Plaintext keys no longer needed — hashed copies live in auth closure

  const rateLimiter = createRateLimiter({
    keyRpm: deps.config.rateLimitRpm,
    tenantRpm: deps.config.rateLimitTenantRpm,
    ingestKeyRpm: deps.config.rateLimitIngestRpm,
  })
  const queryGuard = createConcurrentQueryGuard({
    maxConcurrent: deps.config.maxConcurrentQueries,
  })

  const v1 = Router()
  v1.use(auth)
  v1.use(rateLimiter)
  v1.use(queryGuard)
  v1.use(
    ingestRoutes({
      clusterClient: deps.clusterClient,
      db: deps.db,
      logger: deps.logger,
      anomalyScorer: deps.anomalyScorer,
    }),
  )
  v1.use(
    dashboardRoutes({
      db: deps.db,
      logger: deps.logger,
    }),
  )
  v1.use(
    watchRoutes({
      watchStore: deps.watchStore,
      logger: deps.logger,
    }),
  )
  v1.use(
    settingsRoutes({
      settingsStore: deps.settingsStore,
      logger: deps.logger,
    }),
  )
  v1.use(
    deployRoutes({
      db: deps.db,
      logger: deps.logger,
    }),
  )
  v1.use(
    correlationRoutes({
      db: deps.db,
      logger: deps.logger,
    }),
  )
  app.use('/v1', v1)

  // Dashboard SPA — serve static files if the dist directory exists
  const dashboardDir =
    process.env.LOGWEAVE_DASHBOARD_DIR ?? path.resolve(import.meta.dirname, '../../dashboard/dist')
  if (existsSync(dashboardDir)) {
    deps.logger.info({ dashboardDir }, 'Serving dashboard SPA')
    app.use(express.static(dashboardDir))

    // SPA fallback — serve index.html for unmatched GET requests that accept HTML
    // (API routes and health probes are already handled above)
    // Express 5 requires named wildcard params: {*path}
    app.get('{*path}', (req, res, next) => {
      if (req.accepts('html')) {
        res.sendFile(path.join(dashboardDir, 'index.html'))
      } else {
        next(notFound('Route not found'))
      }
    })
  }

  // 404 catch-all (API routes that didn't match, or no dashboard)
  app.use((_req, _res, next) => {
    next(notFound('Route not found'))
  })

  // Centralized error handler (must be last)
  app.use(createErrorHandler(deps.logger))

  return app
}
