import { createApp } from './app.js'
import { createClickHouseClient } from './clients/clickhouse.js'
import { ClustererHealthChecker } from './clients/clusterer.js'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'

const config = loadConfig()
const logger = createLogger(config.logLevel)
const clickhouse = createClickHouseClient(config.clickhouseUrl)
const clustererHealth = new ClustererHealthChecker(config.clustererUrl, config.clustererTimeoutMs)

const app = createApp({ config, logger, clickhouse, clustererHealth })

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'API server started')
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
