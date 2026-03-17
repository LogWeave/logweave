import express from 'express'
import helmet from 'helmet'
import type pino from 'pino'
import { type Options as PinoHttpOptions, pinoHttp } from 'pino-http'
import type { ClustererHealthChecker } from './clients/clusterer.js'
import type { Config } from './config.js'
import { notFound } from './errors.js'
import { requestContext } from './logger.js'
import { createAuthMiddleware } from './middleware/auth.js'
import { createErrorHandler } from './middleware/error-handler.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import type { DbClient } from './db/client.js'
import type { ClusterClient } from './pipeline/cluster-client.js'
import { healthRoutes } from './routes/health.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { ingestRoutes } from './routes/ingest.js'

export interface AppDependencies {
  config: Config
  logger: pino.Logger
  db: DbClient
  clustererHealth: ClustererHealthChecker
  clusterClient: ClusterClient
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
  app.use(healthRoutes({ db: deps.db, clustererHealth: deps.clustererHealth, clusterClient: deps.clusterClient }))

  // Routes — API (authenticated)
  const auth = createAuthMiddleware(deps.config.apiKeys)
  deps.config.apiKeys.clear() // Plaintext keys no longer needed — hashed copies live in auth closure
  app.use('/v1', auth, ingestRoutes({
    clusterClient: deps.clusterClient,
    db: deps.db,
    logger: deps.logger,
  }))
  app.use('/v1', auth, dashboardRoutes({
    db: deps.db,
    logger: deps.logger,
  }))

  // 404 catch-all
  app.use((_req, _res, next) => {
    next(notFound('Route not found'))
  })

  // Centralized error handler (must be last)
  app.use(createErrorHandler(deps.logger))

  return app
}
