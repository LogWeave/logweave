import { randomBytes } from 'node:crypto'
import { createApp } from './app.js'
import { ApiKeyStore } from './auth/api-key-store.js'
import { writeBootstrapCredentials } from './auth/bootstrap-credentials.js'
import { deriveKeys } from './auth/passwords.js'
import { HmacSessionProvider } from './auth/session.js'
import { ClickHouseUserStore } from './auth/user-store.js'
import { createClickHouseClient } from './clients/clickhouse.js'
import { ClustererHealthChecker } from './clients/clusterer.js'
import { loadConfig } from './config.js'
import { DbClient } from './db/client.js'
import { initSchema } from './db/schema.js'
import { LocalEventBus } from './events/local-bus.js'
import { getInternalEvents, initInternalEvents } from './internal-events/emitter.js'
import { createLogger } from './logger.js'
import { AnomalyScorer } from './pipeline/anomaly-scorer.js'
import { ClusterClient } from './pipeline/cluster-client.js'
import { RecoverySweep } from './recovery/reconcile.js'
import { RetentionSweep } from './retention/sweep.js'
import { TailBuffer } from './tail/buffer.js'
import { AlertEvaluator } from './watches/alert-evaluator.js'
import { AlertDispatcher, ConsoleObserver } from './watches/alert-observer.js'
import { HistoryObserver } from './watches/history-observer.js'
import { RuleStore } from './watches/rule-store.js'
import { SlackObserver } from './watches/slack-observer.js'
import { TenantSettingsStore } from './watches/tenant-settings.js'
import { ThresholdEvaluator } from './watches/threshold-evaluator.js'
import { WatchStore } from './watches/watch-store.js'
import { WebhookObserver } from './watches/webhook-observer.js'

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig()
} catch (err) {
  // Emit config.invalid before any structured logger exists. Use a minimal
  // bootstrap emitter so the failure is captured in the operator event stream.
  initInternalEvents({ service: 'api' })
  const message = err instanceof Error ? err.message : String(err)
  getInternalEvents().emit({
    event: 'config.invalid',
    severity: 'error',
    code: 'CONFIG_INVALID',
    summary: 'config validation failed at startup',
    fields: { error_message: message },
  })
  throw err
}
const logger = createLogger(config.logLevel)

if (!config.clickhouseUser) {
  logger.warn(
    'LOGWEAVE_CLICKHOUSE_USER is not set — ClickHouse is running without authentication. This is insecure in production.',
  )
}
const clickhouse = createClickHouseClient(
  config.clickhouseUrl,
  config.clickhouseUser,
  config.clickhousePassword,
)
const db = new DbClient(clickhouse)
const internalEvents = initInternalEvents({ service: 'api', db })
internalEvents.emitConfigLoaded(config)
const clustererHealth = new ClustererHealthChecker(config.clustererUrl, config.clustererTimeoutMs)
const clusterClient = new ClusterClient(
  config.clustererUrl,
  config.clustererTimeoutMs,
  logger,
  undefined,
  undefined,
  config.clustererInternalSecret,
)
const anomalyScorer = new AnomalyScorer({ db, logger })
const watchStore = new WatchStore({ db, logger })
const settingsStore = new TenantSettingsStore({
  db,
  logger,
  encryptionKey: config.encryptionKey,
})
const ruleStore = new RuleStore({ db, logger })

// Runtime-mutable API keys. Lives alongside env-loaded `config.apiKeys`,
// which remain the bootstrap path. encryptionKey doubles as the HMAC secret
// (domain-separated inside the store) so we don't need a new env var.
const apiKeyStore = config.encryptionKey
  ? new ApiKeyStore({ db, logger, hmacSecret: config.encryptionKey })
  : undefined
const alertDispatcher = new AlertDispatcher(logger)
alertDispatcher.register(new ConsoleObserver(logger))
alertDispatcher.register(
  new SlackObserver({ settingsStore, dashboardBaseUrl: config.dashboardBaseUrl, logger }),
)
alertDispatcher.register(new HistoryObserver({ db, logger }))
alertDispatcher.register(
  new WebhookObserver({ settingsStore, dashboardBaseUrl: config.dashboardBaseUrl, logger }),
)
const alertEvaluator = new AlertEvaluator({
  watchStore,
  anomalyScorer,
  dispatcher: alertDispatcher,
  logger,
})
const thresholdEvaluator = new ThresholdEvaluator({
  ruleStore,
  dispatcher: alertDispatcher,
  db,
  logger,
  settingsStore,
})

try {
  await initSchema(clickhouse, logger)
  internalEvents.emit({
    event: 'migration.applied',
    severity: 'info',
    code: 'SCHEMA_INITIALIZED',
    summary: 'ClickHouse schema initialized',
  })
  await watchStore.loadFromDb()
  await settingsStore.loadFromDb()
  await ruleStore.loadFromDb()
  if (apiKeyStore) {
    // The initial refresh MUST succeed (not the silent-degrade path inside
    // refresh()) because the per-tenant cap in create() is enforced from
    // the cache. An empty cache after a failed boot-time refresh would let
    // a tenant exceed the cap. Treat refresh failure as a startup failure.
    const { count } = await apiKeyStore.refresh()
    if (!apiKeyStore.isReady) {
      throw new Error('ApiKeyStore initial refresh failed; refusing to start')
    }
    logger.info({ count }, 'ApiKeyStore loaded')

    // Migrate env-loaded keys (config.apiKeys) into the table on first boot
    // so they become revocable via the API. After seeding succeeds the env
    // keys are emptied — the DB is the single source of truth from this
    // point on, which avoids the "revoked key comes back to life from env"
    // footgun.
    const seeded: string[] = []
    for (const [rawKey, tenantId] of config.apiKeys.entries()) {
      const added = await apiKeyStore.seedFromBootstrap({
        tenantId,
        rawKey,
        name: 'bootstrap',
      })
      if (added) seeded.push(tenantId)
    }
    if (seeded.length > 0) {
      logger.info(
        { seeded: seeded.length },
        'Migrated env-loaded API keys into api_keys table; clearing env source',
      )
    }
    // Always clear: even if all keys were already in the table, the env Map
    // still holds plaintext secrets that don't need to live past boot.
    config.apiKeys.clear()
  }
} catch (err) {
  internalEvents.emit({
    event: 'clickhouse.unreachable',
    severity: 'error',
    code: 'SCHEMA_INIT_FAILED',
    summary: 'failed to initialize ClickHouse schema',
    fields: { host: new URL(config.clickhouseUrl).host },
  })
  logger.fatal({ err }, 'Failed to initialize ClickHouse schema after retries')
  process.exit(1)
}

// Auth: derive keys, create stores, bootstrap default admin
let sessionProvider: HmacSessionProvider | undefined
let userStore: ClickHouseUserStore | undefined
let totpEncryptionKey: Buffer | undefined
let csrfTokenKey: Buffer | undefined

if (config.encryptionKey) {
  const keys = await deriveKeys(config.encryptionKey)
  sessionProvider = new HmacSessionProvider(keys.sessionSigningKey)
  totpEncryptionKey = keys.totpEncryptionKey
  csrfTokenKey = keys.csrfTokenKey
  userStore = new ClickHouseUserStore(db, logger)

  // Bootstrap default admin if no users exist.
  // Password is randomly generated and printed once to stdout — never use a static default.
  const userCount = await userStore.countUsers()
  if (userCount === 0) {
    // Source the bootstrap-admin tenant from apiKeyStore (the DB-backed source
    // of truth after seeding), NOT config.apiKeys — that Map is cleared on
    // line 142 once env-loaded keys have been migrated, so reading it here
    // always yields empty and the admin ends up in the literal 'default'
    // tenant regardless of LOGWEAVE_API_KEYS. See issue #219.
    const firstTenantId = apiKeyStore?.firstTenantId() ?? 'default'
    const bootstrapPassword = randomBytes(18).toString('base64url')
    await userStore.createUser({
      username: 'admin',
      password: bootstrapPassword,
      tenantId: firstTenantId,
      role: 'admin',
    })
    // Write the bootstrap password directly to stderr (unstructured) instead
    // of through the structured logger. Most log-shipping pipelines (Loki,
    // CloudWatch agent, fluent-bit) consume the JSON stdout stream — keeping
    // the password out of structured logs reduces the chance it gets indexed
    // by downstream log infrastructure. Operators can still capture stderr
    // manually if needed.
    logger.info(
      { tenantId: firstTenantId },
      'Default admin user created — see stderr for one-time password',
    )
    process.stderr.write('\n')
    process.stderr.write('=================================================================\n')
    process.stderr.write('LOGWEAVE BOOTSTRAP — save this admin password now (shown once).\n')
    process.stderr.write(`  Username: admin\n`)
    process.stderr.write(`  Password: ${bootstrapPassword}\n`)
    process.stderr.write(`  Tenant:   ${firstTenantId}\n`)
    process.stderr.write('You will be required to change it on first login.\n')
    process.stderr.write(
      'If you missed this, the same value is at $LOGWEAVE_DATA_DIR/bootstrap-credentials.txt\n',
    )
    process.stderr.write('=================================================================\n\n')

    // Also persist to a file (auto-deleted on first password change). Lets
    // operators recover the password if they miss the stderr banner.
    writeBootstrapCredentials(
      { username: 'admin', password: bootstrapPassword, tenantId: firstTenantId },
      logger,
    )
  }
} else {
  logger.error('=================================================================')
  logger.error('LOGWEAVE_ENCRYPTION_KEY is not set!')
  logger.error('Dashboard login, TOTP, and connector encryption are DISABLED.')
  logger.error('Generate one: openssl rand -hex 32')
  logger.error('=================================================================')
}

const tailBuffer = new TailBuffer()
tailBuffer.start()
const eventBus = new LocalEventBus(tailBuffer, settingsStore)

const { app, tailTokenStore, archiveNotifyConsumer, archiveReconcileSweep } = createApp({
  config,
  logger,
  db,
  clustererHealth,
  clusterClient,
  anomalyScorer,
  ruleStore,
  watchStore,
  settingsStore,
  apiKeyStore,
  tailBuffer,
  eventBus,
  sessionProvider,
  userStore,
  totpEncryptionKey,
  csrfTokenKey,
})

const recovery = new RecoverySweep(
  { db, clusterClient, clustererHealth, logger },
  {
    sweepIntervalMs: config.recoveryIntervalMs,
    sweepMaxRows: 1000,
    batchSize: 500,
    backpressureThresholdMs: 300,
    lookbackHours: config.recoveryLookbackHours,
  },
)

const retention = new RetentionSweep(
  { db, settingsStore, logger },
  { intervalMs: config.retentionIntervalMs },
)

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'API server started')
  internalEvents.emit({
    event: 'service.started',
    severity: 'info',
    code: 'SERVICE_STARTED',
    summary: 'api server listening',
    fields: { port: config.port },
  })

  if (config.retentionEnabled) {
    retention.start()
  } else {
    logger.info('Retention sweep disabled (LOGWEAVE_RETENTION_ENABLED=false)')
  }

  if (config.recoveryEnabled) {
    recovery
      .runStartupReconciliation()
      .then((count) => {
        if (count > 0) logger.info({ count }, 'Startup reconciliation completed')
      })
      .catch((err) => {
        logger.error({ err }, 'Startup reconciliation failed')
      })

    recovery.start()
  } else {
    logger.info('Recovery sweep disabled (LOGWEAVE_RECOVERY_ENABLED=false)')
  }

  if (config.archiveReconcileEnabled) {
    if (archiveReconcileSweep) {
      archiveReconcileSweep.start()
    } else {
      logger.warn(
        'Archive reconciliation enabled but no archive bucket configured — sweep not started',
      )
    }
  } else {
    logger.info('Archive reconciliation sweep disabled (LOGWEAVE_ARCHIVE_RECONCILE_ENABLED=false)')
  }

  anomalyScorer.start()
  alertEvaluator.start()
  thresholdEvaluator.start()
  apiKeyStore?.start()
})

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  logger.info({ signal }, 'Shutdown signal received')
  internalEvents.emit({
    event: 'service.stopping',
    severity: 'info',
    code: 'SERVICE_STOPPING',
    summary: 'shutdown signal received',
    fields: { signal },
  })

  // Force exit after timeout
  const forceTimer = setTimeout(() => {
    logger.error('Shutdown timeout exceeded, forcing exit')
    process.exit(1)
  }, config.shutdownTimeoutMs)
  forceTimer.unref()

  // Stop evaluators, scorer, and recovery sweep before closing connections
  alertEvaluator.stop()
  thresholdEvaluator.stop()
  anomalyScorer.stop()
  apiKeyStore?.stop()
  await recovery.stop()
  await retention.stop()
  await archiveNotifyConsumer?.stop()
  await archiveReconcileSweep?.stop()
  // Stop tail-related background timers (token cleanup, buffer eviction)
  tailTokenStore.stop()
  tailBuffer.stop()
  logger.info('Background sweeps stopped')

  // Stop accepting new connections and drain in-flight requests
  server.close(async () => {
    logger.info('HTTP server closed')
    try {
      await db.close()
      logger.info('ClickHouse client closed')
    } catch (err) {
      logger.error({ err }, 'Error closing ClickHouse client')
    }
    logger.info('Shutdown complete')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
// Route fatal async errors through the same graceful shutdown path (idempotent
// via the `shuttingDown` guard) so background sweeps, the HTTP server, and the
// ClickHouse client are closed cleanly. shutdown()'s force-exit timer remains
// the backstop if a wedged shutdown can't complete in time.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection — shutting down')
  void shutdown('unhandledRejection')
})
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down')
  void shutdown('uncaughtException')
})
