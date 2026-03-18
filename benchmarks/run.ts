import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

import { generateAllFixtures } from './api/fixtures.js'
import { runApiScenario } from './api/harness.js'
import { startMockClusterer, stopMockClusterer } from './api/mock-clusterer.js'
import { buildReport, compareBaseline, printReport, writeReport } from './lib/reporter.js'
import { startApiServer, stopServer, waitForHealthy } from './lib/runner.js'
import type { BenchmarkConfig, CliOptions, ScenarioResult, TransportResult } from './lib/types.js'
import { runTransportScenario } from './transport/harness.js'

const MOCK_CLUSTERER_PORT = 8001
const API_SERVER_PORT = 3001

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  const opts: { tier: 'mock' | 'full'; filter?: string; tag?: string; compare?: string } = {
    tier: 'mock',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    if (arg === '--tier' && next) {
      opts.tier = next === 'full' ? 'full' : 'mock'
      i++
    } else if (arg === '--filter' && next) {
      opts.filter = next
      i++
    } else if (arg === '--tag' && next) {
      opts.tag = next
      i++
    } else if (arg === '--compare' && next) {
      opts.compare = next
      i++
    }
  }

  return opts
}

function loadConfig(): BenchmarkConfig {
  const raw = readFileSync(resolve(__dirname, 'config/scenarios.json'), 'utf8')
  return JSON.parse(raw) as BenchmarkConfig
}

function matchesFilter(name: string, filter?: string): boolean {
  if (!filter) return true
  // Support simple glob-like patterns with *
  const regex = new RegExp(`^${filter.replace(/\*/g, '.*')}$`)
  return regex.test(name)
}

function hasTag(tags: readonly string[] | undefined, tag?: string): boolean {
  if (!tag) return true
  return tags?.includes(tag) ?? false
}

async function runApiBenchmarks(
  config: BenchmarkConfig,
  opts: CliOptions,
): Promise<ScenarioResult[]> {
  const scenarios = config.api_scenarios.filter(
    (s) => matchesFilter(s.name, opts.filter) && hasTag(s.tags, opts.tag),
  )

  if (scenarios.length === 0) {
    console.log('  No API scenarios matched filter/tag\n')
    return []
  }

  // Pre-generate fixtures for all needed batch sizes
  const batchSizes = [...new Set(scenarios.map((s) => s.batch_size))]
  console.log(`  Generating fixtures for batch sizes: ${batchSizes.join(', ')}`)
  const fixtures = generateAllFixtures(batchSizes)

  // Start infrastructure
  let serverProcess: Awaited<ReturnType<typeof startApiServer>> | null = null

  if (opts.tier === 'mock') {
    console.log('  Starting mock clusterer...')
    await startMockClusterer(MOCK_CLUSTERER_PORT)

    const apiKeys: Record<string, string> = { 'bench-key': 'bench-tenant' }
    // Add multi-tenant keys if needed
    const maxTenants = Math.max(...scenarios.map((s) => s.tenant_count ?? 1))
    for (let i = 0; i < maxTenants; i++) {
      apiKeys[`bench-key-${i.toString()}`] = `bench-tenant-${i.toString()}`
    }

    console.log('  Starting API server...')
    serverProcess = startApiServer(
      {
        LOGWEAVE_CLICKHOUSE_URL: 'http://localhost:8123',
        LOGWEAVE_CLUSTERER_URL: `http://localhost:${MOCK_CLUSTERER_PORT.toString()}`,
        LOGWEAVE_API_KEYS: JSON.stringify(apiKeys),
        LOGWEAVE_LOG_LEVEL: 'warn',
        LOGWEAVE_RECOVERY_INTERVAL_MS: '300000', // Disable recovery during benchmarks
      },
      API_SERVER_PORT,
    )

    console.log('  Waiting for API server health...')
    await waitForHealthy(`http://localhost:${API_SERVER_PORT.toString()}/healthz`)
    console.log('  API server ready\n')
  } else {
    // Full tier: expect docker compose running
    console.log('  Checking API server health (full tier)...')
    await waitForHealthy('http://localhost:3000/healthz')
    console.log('  API server ready\n')
  }

  const port = opts.tier === 'mock' ? API_SERVER_PORT : 3000
  const results: ScenarioResult[] = []

  try {
    for (const scenario of scenarios) {
      console.log(`  ▸ ${scenario.name}: ${scenario.description}`)

      // Handle clusterer-down scenario
      if (scenario.clusterer_mode === 'down' && opts.tier === 'mock') {
        await stopMockClusterer()
      }

      const fixtureSet = fixtures.get(scenario.batch_size)
      if (!fixtureSet) {
        console.log(`    SKIP — no fixtures for batch size ${scenario.batch_size.toString()}`)
        continue
      }

      const result = await runApiScenario(scenario, fixtureSet, port, {
        warmUpSeconds: config.defaults.warm_up_seconds,
        measuredRuns: config.defaults.measured_runs,
        aggregation: config.defaults.stat_aggregation,
      })

      results.push(result)
      console.log(
        `    → ${Math.round(result.results.events_per_second).toLocaleString()} ev/s, p99=${result.results.latency_ms.p99}ms, ${result.verdict}\n`,
      )

      // Restart mock clusterer if it was stopped
      if (scenario.clusterer_mode === 'down' && opts.tier === 'mock') {
        await startMockClusterer(MOCK_CLUSTERER_PORT)
      }
    }
  } finally {
    if (serverProcess) {
      console.log('  Stopping API server...')
      await stopServer(serverProcess)
    }
    if (opts.tier === 'mock') {
      await stopMockClusterer()
    }
  }

  return results
}

async function runTransportBenchmarks(
  config: BenchmarkConfig,
  opts: CliOptions,
): Promise<TransportResult[]> {
  const scenarios = config.transport_scenarios.filter((s) => matchesFilter(s.name, opts.filter))

  if (scenarios.length === 0) {
    console.log('  No transport scenarios matched filter\n')
    return []
  }

  const results: TransportResult[] = []

  for (const scenario of scenarios) {
    console.log(`  ▸ ${scenario.name}: ${scenario.description}`)
    const result = await runTransportScenario(scenario)
    results.push(result)
    console.log(
      `    → ${Math.round(result.results.events_per_second).toLocaleString()} ev/s, ${result.results.dropped_events} dropped, ${result.verdict}\n`,
    )
  }

  return results
}

async function main(): Promise<void> {
  const opts = parseArgs()
  const config = loadConfig()

  console.log('\n  LogWeave Benchmark Suite')
  console.log(`  Tier: ${opts.tier}`)
  if (opts.filter) console.log(`  Filter: ${opts.filter}`)
  if (opts.tag) console.log(`  Tag: ${opts.tag}`)
  console.log()

  const apiResults = await runApiBenchmarks(config, opts)
  const transportResults = await runTransportBenchmarks(config, opts)

  // Build report
  const report = buildReport(apiResults, transportResults, opts.tier)

  // Compare against baseline if requested
  if (opts.compare) {
    const { regressions, improvements } = compareBaseline(
      report,
      opts.compare,
      config.regression_thresholds,
    )
    // Attach comparison to report
    const reportWithComparison = {
      ...report,
      summary: {
        ...report.summary,
        baseline_comparison: {
          baseline_file: opts.compare,
          regressions,
          improvements,
        },
      },
    }
    printReport(reportWithComparison)
    writeReport(
      reportWithComparison,
      resolve(__dirname, `results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    )

    if (regressions.length > 0) {
      process.exit(1)
    }
  } else {
    printReport(report)
    writeReport(
      report,
      resolve(__dirname, `results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    )
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
