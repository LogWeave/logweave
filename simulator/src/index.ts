import path from 'node:path'
import { runBackfill } from './backfill.js'
import { parseArgs } from './cli.js'
import { loadDefaults, loadServiceConfigs } from './config.js'
import { Runner } from './runner.js'

const CONFIG_DIR = path.resolve(import.meta.dirname, '../config')

async function main(): Promise<void> {
  const options = parseArgs()

  const defaults = loadDefaults(path.join(CONFIG_DIR, 'defaults.json'))
  const allServices = loadServiceConfigs(path.join(CONFIG_DIR, 'services'))

  // Filter services if --services is specified
  const services =
    options.services[0] === 'all'
      ? allServices
      : allServices.filter((s) => options.services.includes(s.service))

  if (services.length === 0) {
    const available = allServices.map((s) => s.service).join(', ')
    console.error(`No matching services found. Available: ${available}`)
    process.exit(1)
  }

  // Apply defaults only for flags not explicitly provided
  if (!options._explicit.rate) options.rate = defaults.rate
  if (!options._explicit.bufferSize) options.bufferSize = defaults.buffer_size
  if (!options._explicit.flushMs) options.flushMs = defaults.flush_interval_ms

  // Backfill mode: generate historical data and exit (no live streaming).
  if (options.backfillDays > 0) {
    await runBackfill({
      services,
      days: options.backfillDays,
      peakRate: options.backfillRate,
      apiKey: options.apiKey,
      endpoint: options.endpoint,
      dryRun: options.dryRun,
    })
    return
  }

  const runner = new Runner({ services, options, defaults })

  // Graceful shutdown on SIGINT
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await runner.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  runner.start()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
