import { createApp } from './app.js'
import { deriveKeys } from './auth/passwords.js'
import { HmacSessionProvider } from './auth/session.js'
import { ClickHouseUserStore } from './auth/user-store.js'
import { createClickHouseClient } from './clients/clickhouse.js'
import { ClustererHealthChecker } from './clients/clusterer.js'
import { loadConfig } from './config.js'
import { DbClient } from './db/client.js'
import { initSchema } from './db/schema.js'
import { createLogger } from './logger.js'
import { AnomalyScorer } from './pipeline/anomaly-scorer.js'
import { ClusterClient } from './pipeline/cluster-client.js'
import { LocalEventBus } from './events/local-bus.js'
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
import { WebhookObserver } from './watches/webhook-observer.js'
import { WatchStore } from './watches/watch-store.js'

const config = loadConfig()
const logger = createLogger(config.logLevel)
const clickhouse = createClickHouseClient(config.clickhouseUrl, config.clickhouseUser, config.clickhousePassword)
const db = new DbClient(clickhouse)
const clustererHealth = new ClustererHealthChecker(config.clustererUrl, config.clustererTimeoutMs)
const clusterClient = new ClusterClient(config.clustererUrl, config.clustererTimeoutMs, logger)
const anomalyScorer = new AnomalyScorer({ db, logger })
const watchStore = new WatchStore({ db, logger })
const settingsStore = new TenantSettingsStore({ db, logger })
const ruleStore = new RuleStore({ db, logger })
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
  await watchStore.loadFromDb()
  await settingsStore.loadFromDb()
  await ruleStore.loadFromDb()
} catch (err) {
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

  // Bootstrap default admin if no users exist
  const userCount = await userStore.countUsers()
  if (userCount === 0) {
    const firstTenantId = [...config.apiKeys.values()][0] ?? 'default'
    await userStore.createUser({
      username: 'admin',
      password: 'admin',
      tenantId: firstTenantId,
      role: 'admin',
    })
    logger.info({ tenantId: firstTenantId }, 'Default admin user created (admin/admin) — change password on first login')
  }
} else {
  logger.error('=================================================================')
  logger.error('LOGWEAVE_ENCRYPTION_KEY is not set!')
  logger.error('Dashboard login, TOTP, and connector encryption are DISABLED.')
  logger.error('Generate one: openssl rand -hex 16')
  logger.error('=================================================================')
}

const tailBuffer = new TailBuffer()
tailBuffer.start()
const eventBus = new LocalEventBus(tailBuffer, settingsStore)

const app = createApp({
  config,
  logger,
  db,
  clustererHealth,
  clusterClient,
  anomalyScorer,
  ruleStore,
  watchStore,
  settingsStore,
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
  anomalyScorer.start()
  alertEvaluator.start()
  thresholdEvaluator.start()
})

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  logger.info({ signal }, 'Shutdown signal received')

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
  await recovery.stop()
  await retention.stop()
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
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection — shutting down')
  process.exit(1)
})
