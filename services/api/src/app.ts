import { existsSync } from 'node:fs'
import path from 'node:path'
import cookieParser from 'cookie-parser'
import express, { Router } from 'express'
import helmet from 'helmet'
import type pino from 'pino'
import { type Options as PinoHttpOptions, pinoHttp } from 'pino-http'
import type { ClustererHealthChecker } from './clients/clusterer.js'
import type { Config } from './config.js'
import type { DbClient } from './db/client.js'
import { notFound } from './errors.js'
import type { EventBus } from './events/event-bus.js'
import { requestContext } from './logger.js'
import { SessionValidationCache } from './auth/session-cache.js'
import { KeyStore, createAuthMiddleware } from './middleware/auth.js'
import { createConcurrentQueryGuard } from './middleware/concurrent-query-guard.js'
import { createErrorHandler } from './middleware/error-handler.js'
import { createCsrfMiddleware } from './middleware/csrf.js'
import { createMcpDetectMiddleware } from './middleware/mcp-detect.js'
import { createRateLimiter } from './middleware/rate-limit.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import type { SessionProvider } from './auth/session.js'
import type { UserStore } from './auth/user-store.js'
import type { AnomalyScorer } from './pipeline/anomaly-scorer.js'
import type { ClusterClient } from './pipeline/cluster-client.js'
import { authRoutes } from './routes/auth.js'
import { connectorRoutes } from './routes/connectors.js'
import { correlationRoutes } from './routes/correlation.js'
import { compositeRoutes } from './routes/composite.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { deployRoutes } from './routes/deploys.js'
import { healthRoutes } from './routes/health.js'
import { ingestRoutes } from './routes/ingest.js'
import { genericIngestRoutes } from './routes/ingest-generic.js'
import { otlpIngestRoutes } from './routes/ingest-otlp.js'
import { rawLogsRoutes } from './routes/raw-logs.js'
import { ruleRoutes } from './routes/rules.js'
import { settingsRoutes } from './routes/settings.js'
import { tagRoutes } from './routes/tags.js'
import { tailRoutes, tailSseRoute } from './routes/tail.js'
import { watchRoutes } from './routes/watches.js'
import type { TailBuffer } from './tail/buffer.js'
import { TailTokenStore } from './tail/token-store.js'
import type { RuleStore } from './watches/rule-store.js'
import type { TenantSettingsStore } from './watches/tenant-settings.js'
import type { WatchStore } from './watches/watch-store.js'

export interface AppDependencies {
  config: Config
  logger: pino.Logger
  db: DbClient
  clustererHealth: ClustererHealthChecker
  clusterClient: ClusterClient
  anomalyScorer: AnomalyScorer
  ruleStore: RuleStore
  watchStore: WatchStore
  settingsStore: TenantSettingsStore
  tailBuffer?: TailBuffer
  eventBus?: EventBus
  sessionProvider?: SessionProvider
  userStore?: UserStore
  totpEncryptionKey?: Buffer
  csrfTokenKey?: Buffer
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express()
  app.disable('x-powered-by')

  // Request-id middleware (must be first — sets up AsyncLocalStorage context)
  app.use(requestIdMiddleware)

  // Security headers with Content Security Policy
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  )

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

  // Body parsing — skip for OTLP route (has its own gzip + 5MB limit middleware)
  app.use((req, res, next) => {
    if (req.path === '/v1/logs') return next()
    express.json({ limit: '1mb' })(req, res, next)
  })

  // Cookie parsing (required for session auth)
  app.use(cookieParser())

  // Routes — health (unauthenticated)
  app.use(
    healthRoutes({
      db: deps.db,
      clustererHealth: deps.clustererHealth,
      clusterClient: deps.clusterClient,
    }),
  )

  // Routes — auth (partially unauthenticated: login, logout, me)
  if (deps.userStore && deps.sessionProvider && deps.totpEncryptionKey) {
    app.use(
      '/v1',
      authRoutes({
        userStore: deps.userStore,
        sessionProvider: deps.sessionProvider,
        db: deps.db,
        logger: deps.logger,
        totpEncryptionKey: deps.totpEncryptionKey,
        isProduction: process.env.NODE_ENV === 'production',
      }),
    )
  }

  // Routes — API (authenticated, rate-limited)
  const keyStore = KeyStore.fromMapAndClear(deps.config.apiKeys)
  const sessionCache = new SessionValidationCache()
  const auth = createAuthMiddleware(keyStore, deps.sessionProvider, sessionCache, deps.userStore)

  const rateLimiter = createRateLimiter({
    keyRpm: deps.config.rateLimitRpm,
    tenantRpm: deps.config.rateLimitTenantRpm,
    ingestKeyRpm: deps.config.rateLimitIngestRpm,
  })
  const queryGuard = createConcurrentQueryGuard({
    maxConcurrent: deps.config.maxConcurrentQueries,
  })

  const mcpDetect = createMcpDetectMiddleware({
    settingsStore: deps.settingsStore,
    logger: deps.logger,
  })

  const v1 = Router()
  v1.use(auth)
  if (deps.csrfTokenKey) {
    const csrf = createCsrfMiddleware(deps.csrfTokenKey)
    v1.use(csrf.tokenSetter)
    v1.use(csrf.tokenValidator)
  }
  v1.use(mcpDetect)
  v1.use(rateLimiter)
  v1.use(queryGuard)
  const ingestDeps = {
    clusterClient: deps.clusterClient,
    db: deps.db,
    logger: deps.logger,
    anomalyScorer: deps.anomalyScorer,
    tailBuffer: deps.tailBuffer,
    settingsStore: deps.settingsStore,
    eventBus: deps.eventBus,
  }
  v1.use(ingestRoutes(ingestDeps))
  v1.use(genericIngestRoutes(ingestDeps))
  v1.use(otlpIngestRoutes(ingestDeps))
  v1.use(
    dashboardRoutes({
      db: deps.db,
      logger: deps.logger,
      clusterClient: deps.clusterClient,
    }),
  )
  v1.use(
    compositeRoutes({
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
    ruleRoutes({
      ruleStore: deps.ruleStore,
      db: deps.db,
      logger: deps.logger,
    }),
  )
  v1.use(
    settingsRoutes({
      settingsStore: deps.settingsStore,
      db: deps.db,
      clusterClient: deps.clusterClient,
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
  v1.use(
    connectorRoutes({
      db: deps.db,
      logger: deps.logger,
      encryptionKey: deps.config.encryptionKey,
    }),
  )
  v1.use(
    tagRoutes({
      db: deps.db,
      logger: deps.logger,
    }),
  )
  v1.use(
    rawLogsRoutes({
      db: deps.db,
      logger: deps.logger,
      encryptionKey: deps.config.encryptionKey,
    }),
  )
  const tailTokenStore = new TailTokenStore()
  tailTokenStore.start()

  if (deps.tailBuffer) {
    const tailDeps = {
      tailBuffer: deps.tailBuffer,
      settingsStore: deps.settingsStore,
      tailTokenStore,
      db: deps.db,
      logger: deps.logger,
    }
    // Authenticated tail routes (token exchange, poll, stats)
    v1.use(tailRoutes(tailDeps))
    // SSE route — handles its own auth via ?token= (no global auth middleware)
    // Must be mounted before the authenticated v1 router
    app.use('/v1', tailSseRoute(tailDeps))
  }

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
