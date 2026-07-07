import { existsSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import path from 'node:path'
import cookieParser from 'cookie-parser'
import express, { Router } from 'express'
import helmet from 'helmet'
import type pino from 'pino'
import { type Options as PinoHttpOptions, pinoHttp } from 'pino-http'
import { ArchiveCompactionSweep } from './archive/compaction-sweep.js'
import { ArchiveNotifyConsumer } from './archive/notify-consumer.js'
import { ArchiveNotifyQueue } from './archive/notify-queue.js'
import { ArchiveReconcileSweep } from './archive/reconcile-sweep.js'
import type { ApiKeyStore } from './auth/api-key-store.js'
import type { SessionProvider } from './auth/session.js'
import { SessionValidationCache } from './auth/session-cache.js'
import type { UserStore } from './auth/user-store.js'
import type { ClustererHealthChecker } from './clients/clusterer.js'
import type { Config } from './config.js'
import { buildArchiveConfig } from './connectors/archive-config.js'
import { S3Adapter } from './connectors/s3-adapter.js'
import type { DbClient } from './db/client.js'
import { notFound } from './errors.js'
import type { EventBus } from './events/event-bus.js'
import { getInternalEvents } from './internal-events/emitter.js'
import { requestContext } from './logger.js'
import { createAccessAuditMiddleware } from './middleware/audit-access.js'
import { createAuthMiddleware, KeyStore } from './middleware/auth.js'
import { createConcurrentQueryGuard } from './middleware/concurrent-query-guard.js'
import { createCsrfMiddleware } from './middleware/csrf.js'
import { createErrorHandler } from './middleware/error-handler.js'
import { createMcpDetectMiddleware } from './middleware/mcp-detect.js'
import { createRateLimiter } from './middleware/rate-limit.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import type { AnomalyScorer } from './pipeline/anomaly-scorer.js'
import type { ClusterClient } from './pipeline/cluster-client.js'
import { apiKeyRoutes } from './routes/api-keys.js'
import { authRoutes } from './routes/auth.js'
import { compositeRoutes } from './routes/composite.js'
import { connectorRoutes } from './routes/connectors.js'
import { correlationRoutes } from './routes/correlation.js'
import { costRoutes } from './routes/cost.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { deployRoutes } from './routes/deploys.js'
import { healthRoutes } from './routes/health.js'
import { ingestRoutes } from './routes/ingest.js'
import { genericIngestRoutes } from './routes/ingest-generic.js'
import { ingestNotifyRoutes } from './routes/ingest-notify.js'
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

/**
 * Redact live-credential headers before a request is logged. `cookie` carries the
 * `logweave_session` credential and `x-csrf-token` the CSRF token, alongside
 * `authorization` and the internal-services secret. Absent headers stay absent
 * (undefined ⇒ omitted by pino). Exported for regression coverage — every
 * credential-bearing header MUST be listed here.
 */
export function redactRequestHeaders(
  headers: IncomingHttpHeaders | undefined,
): IncomingHttpHeaders {
  return {
    ...headers,
    authorization: headers?.authorization ? '[REDACTED]' : undefined,
    'x-internal-secret': headers?.['x-internal-secret'] ? '[REDACTED]' : undefined,
    cookie: headers?.cookie ? '[REDACTED]' : undefined,
    'x-csrf-token': headers?.['x-csrf-token'] ? '[REDACTED]' : undefined,
  }
}

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
  /** DB-managed API keys (runtime-mutable; CRUD without restart). */
  apiKeyStore?: ApiKeyStore
  tailBuffer?: TailBuffer
  eventBus?: EventBus
  sessionProvider?: SessionProvider
  userStore?: UserStore
  totpEncryptionKey?: Buffer
  csrfTokenKey?: Buffer
}

export interface CreatedApp {
  app: express.Express
  /** Resources created inside createApp that need stop() at shutdown. */
  tailTokenStore: TailTokenStore
  /** Archive notify queue (#276); the async consumer (#277) drains it. */
  archiveNotifyQueue: ArchiveNotifyQueue
  /** Async Drain3 consumer (#277); present only when an archive bucket is set. */
  archiveNotifyConsumer?: ArchiveNotifyConsumer
  /** Reconciliation sweep (#279); present only when an archive bucket is set. */
  archiveReconcileSweep?: ArchiveReconcileSweep
  /** Compaction sweep (#284); present only when an archive bucket is set. */
  archiveCompactionSweep?: ArchiveCompactionSweep
}

export function createApp(deps: AppDependencies): CreatedApp {
  const app = express()
  app.disable('x-powered-by')

  // Controls whether X-Forwarded-For is trusted for req.ip. Off by default so a
  // direct client can't spoof its IP; set LOGWEAVE_TRUST_PROXY=true behind the
  // reverse proxy (Caddy/nginx) so rate-limiting and lockout key on the real IP.
  app.set('trust proxy', deps.config.trustProxy)

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
          headers: redactRequestHeaders(req.raw?.headers),
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

  // Routes — archive notify (#276). Internal-only (Vector → API), guarded by
  // the shared internal secret, NOT tenant API-key auth — so it is mounted
  // BEFORE the authenticated /v1 router. The async consumer (#277) drains this.
  const archiveNotifyQueue = new ArchiveNotifyQueue()
  app.use(
    ingestNotifyRoutes({
      queue: archiveNotifyQueue,
      logger: deps.logger,
      internalSecret: deps.config.clustererInternalSecret,
    }),
  )

  // Routes — auth (partially unauthenticated: login, logout, me)
  if (deps.userStore && deps.sessionProvider && deps.totpEncryptionKey) {
    const authRouter = Router()
    // CSRF on state-changing auth routes (password change, TOTP disable, user
    // create/delete, logout). The validator self-exempts login (no session
    // cookie yet), Bearer auth, and safe methods; tokenSetter seeds the cookie.
    if (deps.csrfTokenKey) {
      const authCsrf = createCsrfMiddleware(deps.csrfTokenKey, {
        isProduction: process.env.NODE_ENV === 'production',
      })
      // Scope to /auth so non-auth /v1/* requests (which get their own CSRF on
      // the v1 router below) don't run this pair twice.
      authRouter.use('/auth', authCsrf.tokenSetter)
      authRouter.use('/auth', authCsrf.tokenValidator)
    }
    authRouter.use(
      authRoutes({
        userStore: deps.userStore,
        sessionProvider: deps.sessionProvider,
        db: deps.db,
        logger: deps.logger,
        totpEncryptionKey: deps.totpEncryptionKey,
        isProduction: process.env.NODE_ENV === 'production',
      }),
    )
    app.use('/v1', authRouter)
  }

  // Routes — API (authenticated, rate-limited)
  const keyStore = KeyStore.fromMapAndClear(deps.config.apiKeys, deps.config.encryptionKey)
  const sessionCache = new SessionValidationCache()
  const auth = createAuthMiddleware({
    envKeys: keyStore,
    apiKeyStore: deps.apiKeyStore,
    sessionProvider: deps.sessionProvider,
    sessionCache,
    userStore: deps.userStore,
    logger: deps.logger,
  })

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
    const csrf = createCsrfMiddleware(deps.csrfTokenKey, {
      isProduction: process.env.NODE_ENV === 'production',
    })
    v1.use(csrf.tokenSetter)
    v1.use(csrf.tokenValidator)
  }
  v1.use(mcpDetect)
  v1.use(createAccessAuditMiddleware({ db: deps.db, logger: deps.logger }))
  v1.use(rateLimiter)
  // Fail loud on a black-hole misconfig: forwarding ingest to Vector relies on
  // the async consumer (#277) to cluster + insert the landed objects, and the
  // consumer only runs when an archive bucket is configured. With the URL set
  // but no bucket, events would land in S3 with nothing ever ingesting them.
  if (deps.config.vectorArchiveUrl && !deps.config.archiveBucket) {
    throw new Error(
      'LOGWEAVE_VECTOR_ARCHIVE_URL is set but LOGWEAVE_ARCHIVE_BUCKET is not. ' +
        'Forwarding ingest to Vector without the async consumer running would ' +
        'black-hole events. Set the archive bucket or unset the Vector URL.',
    )
  }
  const ingestDeps = {
    clusterClient: deps.clusterClient,
    db: deps.db,
    logger: deps.logger,
    anomalyScorer: deps.anomalyScorer,
    tailBuffer: deps.tailBuffer,
    settingsStore: deps.settingsStore,
    eventBus: deps.eventBus,
    // When set, ingest routes forward to the Vector archive engine (durable S3)
    // and the async consumer clusters off the hot path, instead of clustering
    // synchronously here (epic #265).
    vectorArchiveUrl: deps.config.vectorArchiveUrl,
  }
  // Ingest routes are mounted BEFORE the concurrent-query guard so the guard
  // (sized for heavy read/analytics queries) does not also cap ingest
  // concurrency. Ingest is still bounded by the rate limiter above.
  v1.use(ingestRoutes(ingestDeps))
  v1.use(genericIngestRoutes(ingestDeps))
  v1.use(otlpIngestRoutes(ingestDeps))
  // Guard the read/query routes that follow (dashboard, composite, cost,
  // correlation, etc.) against unbounded concurrent expensive queries.
  v1.use(queryGuard)
  v1.use(
    dashboardRoutes({
      db: deps.db,
      logger: deps.logger,
      clusterClient: deps.clusterClient,
      anomalyScorer: deps.anomalyScorer,
    }),
  )
  v1.use(
    compositeRoutes({
      db: deps.db,
      logger: deps.logger,
      anomalyScorer: deps.anomalyScorer,
    }),
  )
  v1.use(
    watchRoutes({
      watchStore: deps.watchStore,
      db: deps.db,
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
  if (deps.apiKeyStore) {
    v1.use(
      apiKeyRoutes({
        db: deps.db,
        logger: deps.logger,
        apiKeyStore: deps.apiKeyStore,
      }),
    )
  }
  v1.use(
    settingsRoutes({
      settingsStore: deps.settingsStore,
      db: deps.db,
      clusterClient: deps.clusterClient,
      logger: deps.logger,
    }),
  )
  v1.use(
    costRoutes({
      db: deps.db,
      logger: deps.logger,
      settingsStore: deps.settingsStore,
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
  // Connectors encrypt/decrypt their stored config, so they only mount when an
  // encryption key is configured — without it the feature can't function.
  if (deps.config.encryptionKey) {
    v1.use(
      connectorRoutes({
        db: deps.db,
        logger: deps.logger,
        encryptionKey: deps.config.encryptionKey,
        awsAccountId: deps.config.awsAccountId,
        s3CfnTemplateUrl: deps.config.s3CfnTemplateUrl,
      }),
    )
  } else {
    deps.logger.warn('Connector routes disabled — LOGWEAVE_ENCRYPTION_KEY not set')
  }
  v1.use(
    tagRoutes({
      db: deps.db,
      logger: deps.logger,
    }),
  )
  // Dev static creds (AWS_ACCESS_KEY_ID/SECRET) are only used when an archive S3
  // endpoint is set (Floci); prod uses the EC2 instance role. Shared by both the
  // drill-down read path (rawLogsRoutes) and the async consumer below.
  const archiveConfig = buildArchiveConfig({
    bucket: deps.config.archiveBucket,
    region: deps.config.archiveRegion,
    endpoint: deps.config.archiveS3Endpoint,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  })
  v1.use(
    rawLogsRoutes({
      db: deps.db,
      logger: deps.logger,
      encryptionKey: deps.config.encryptionKey,
      archiveConfig,
    }),
  )

  // Async Drain3 consumer (#277): drains the notify queue, GETs each archived
  // object, clusters it, and writes log_metadata with source_ref. Only runs when
  // an archive bucket is configured. Started here; index.ts stops it on shutdown.
  let archiveNotifyConsumer: ArchiveNotifyConsumer | undefined
  let archiveReconcileSweep: ArchiveReconcileSweep | undefined
  let archiveCompactionSweep: ArchiveCompactionSweep | undefined
  if (archiveConfig) {
    archiveNotifyConsumer = new ArchiveNotifyConsumer({
      queue: archiveNotifyQueue,
      archiveConfig,
      ingest: ingestDeps,
      adapter: new S3Adapter(),
      logger: deps.logger,
    })
    archiveNotifyConsumer.start()

    // Reconciliation sweep (#279): finds objects the notify hop missed and
    // re-feeds them through the same queue+consumer. Constructed here (it needs
    // the in-proc queue); index.ts starts/stops it, gated on its enable flag.
    archiveReconcileSweep = new ArchiveReconcileSweep(
      {
        db: deps.db,
        adapter: new S3Adapter(),
        archiveConfig,
        queue: archiveNotifyQueue,
        settingsStore: deps.settingsStore,
        // Also sweep forward-only tenants that authenticate but have no settings
        // row yet, so their forwarded objects aren't black-holed (#287).
        apiKeyStore: deps.apiKeyStore,
        logger: deps.logger,
        emitter: getInternalEvents(),
      },
      { intervalMs: deps.config.archiveReconcileIntervalMs },
    )

    // Compaction sweep (#284): merges small objects in closed partitions.
    // index.ts starts/stops it, gated on its enable flag.
    archiveCompactionSweep = new ArchiveCompactionSweep(
      {
        db: deps.db,
        adapter: new S3Adapter(),
        archiveConfig,
        settingsStore: deps.settingsStore,
        logger: deps.logger,
      },
      { intervalMs: deps.config.archiveCompactionIntervalMs },
    )
  }

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

  return {
    app,
    tailTokenStore,
    archiveNotifyQueue,
    archiveNotifyConsumer,
    archiveReconcileSweep,
    archiveCompactionSweep,
  }
}
