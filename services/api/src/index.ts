import { createApp } from './app.js'
import { createClickHouseClient } from './clients/clickhouse.js'
import { ClustererHealthChecker } from './clients/clusterer.js'
import { loadConfig } from './config.js'
import { DbClient } from './db/client.js'
import { initSchema } from './db/schema.js'
import { createLogger } from './logger.js'
import { ClusterClient } from './pipeline/cluster-client.js'
import { RecoverySweep } from './recovery/reconcile.js'

const config = loadConfig()
const logger = createLogger(config.logLevel)
const clickhouse = createClickHouseClient(config.clickhouseUrl)
const clustererHealth = new ClustererHealthChecker(config.clustererUrl, config.clustererTimeoutMs)
const clusterClient = new ClusterClient(config.clustererUrl, config.clustererTimeoutMs, logger)

try {
  await initSchema(clickhouse, logger)
} catch (err) {
  logger.fatal({ err }, 'Failed to initialize ClickHouse schema after retries')
  process.exit(1)
}

const app = createApp({ config, logger, clickhouse, clustererHealth, clusterClient })
const db = new DbClient(clickhouse)

const recovery = new RecoverySweep(
  { db, clickhouse, clusterClient, clustererHealth, logger },
  { sweepIntervalMs: config.recoveryIntervalMs, sweepMaxRows: 1000, batchSize: 500, backpressureThresholdMs: 300 },
)

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'API server started')

  recovery.runStartupReconciliation().then((count) => {
    if (count > 0) logger.info({ count }, 'Startup reconciliation completed')
  }).catch((err) => {
    logger.error({ err }, 'Startup reconciliation failed')
  })

  recovery.start()
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

  // Stop recovery sweep before closing connections
  await recovery.stop()
  logger.info('Recovery sweep stopped')

  // Stop accepting new connections and drain in-flight requests
  server.close(async () => {
    logger.info('HTTP server closed')
    try {
      await clickhouse.close()
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
