import autocannon from 'autocannon'
import type { ApiScenario, ScenarioResult } from '../lib/types.js'
import { takeMemorySnapshot } from '../lib/memory.js'
import { aggregate, sleep } from '../lib/runner.js'
import type { FixtureSet } from './fixtures.js'

/**
 * Run a single API benchmark scenario using autocannon.
 * Returns aggregated results across multiple measured runs.
 */
export async function runApiScenario(
  scenario: ApiScenario,
  fixtures: FixtureSet,
  serverPort: number,
  options: { warmUpSeconds: number; measuredRuns: number; aggregation: 'median' | 'mean' },
): Promise<ScenarioResult> {
  const baseUrl = `http://localhost:${serverPort.toString()}`
  const url = `${baseUrl}${scenario.endpoint}`

  // Pre-serialize payloads for round-robin
  const bodies = fixtures.payloads
  let bodyIndex = 0

  const autocannonOpts: autocannon.Options = {
    url,
    method: scenario.method as 'POST',
    connections: scenario.connections,
    headers: {
      'Content-Type': 'application/json',
      ...scenario.headers,
    },
    setupClient(client) {
      client.setBody(bodies[bodyIndex % bodies.length]!)
      bodyIndex++
    },
  }

  if (scenario.amount != null) {
    autocannonOpts.amount = scenario.amount
  } else {
    autocannonOpts.duration = scenario.duration_seconds ?? 30
  }

  // Warm-up run (results discarded)
  console.log(`    Warm-up (${options.warmUpSeconds}s)...`)
  await autocannon({
    ...autocannonOpts,
    duration: options.warmUpSeconds,
  })
  await sleep(1000) // Brief pause between runs

  // Measured runs
  const runs: autocannon.Result[] = []
  for (let i = 0; i < options.measuredRuns; i++) {
    console.log(`    Run ${(i + 1).toString()}/${options.measuredRuns.toString()}...`)
    bodyIndex = 0 // Reset round-robin
    const memBefore = takeMemorySnapshot()
    const result = await autocannon(autocannonOpts)
    const memAfter = takeMemorySnapshot()

    // Attach memory to result for later aggregation
    ;(result as autocannon.Result & { _memBefore?: typeof memBefore; _memAfter?: typeof memAfter })._memBefore = memBefore
    ;(result as autocannon.Result & { _memBefore?: typeof memBefore; _memAfter?: typeof memAfter })._memAfter = memAfter

    runs.push(result)
    if (i < options.measuredRuns - 1) await sleep(1000)
  }

  // Aggregate across runs
  const reqsPerSec = aggregate(
    runs.map((r) => r.requests.average),
    options.aggregation,
  )
  const eventsPerSec = reqsPerSec * scenario.batch_size
  const p50 = aggregate(
    runs.map((r) => r.latency.p50),
    options.aggregation,
  )
  const p95 = aggregate(
    runs.map((r) => (r.latency as autocannon.Result['latency'] & { p95?: number }).p95 ?? r.latency.p99),
    options.aggregation,
  )
  const p99 = aggregate(
    runs.map((r) => r.latency.p99),
    options.aggregation,
  )
  const latMax = Math.max(...runs.map((r) => r.latency.max))
  const latAvg = aggregate(
    runs.map((r) => r.latency.average),
    options.aggregation,
  )
  const totalErrors = runs.reduce((sum, r) => sum + (r.errors ?? 0), 0)
  const totalTimeouts = runs.reduce((sum, r) => sum + (r.timeouts ?? 0), 0)
  const totalRequests = runs.reduce((sum, r) => sum + r.requests.total, 0)

  // Memory from first and last run
  const firstMem = (runs[0] as autocannon.Result & { _memBefore?: { rss_mb: number; heap_used_mb: number } })._memBefore ?? takeMemorySnapshot()
  const lastMem = (runs[runs.length - 1] as autocannon.Result & { _memAfter?: { rss_mb: number; heap_used_mb: number } })._memAfter ?? takeMemorySnapshot()

  return {
    name: scenario.name,
    description: scenario.description,
    config: {
      batch_size: scenario.batch_size,
      connections: scenario.connections,
      duration_seconds: scenario.duration_seconds,
      amount: scenario.amount,
    },
    results: {
      requests_per_second: Math.round(reqsPerSec * 10) / 10,
      events_per_second: Math.round(eventsPerSec),
      latency_ms: {
        p50: Math.round(p50 * 10) / 10,
        p95: Math.round(p95 * 10) / 10,
        p99: Math.round(p99 * 10) / 10,
        max: Math.round(latMax * 10) / 10,
        average: Math.round(latAvg * 10) / 10,
      },
      errors: totalErrors,
      timeouts: totalTimeouts,
      total_requests: totalRequests,
      total_events: totalRequests * scenario.batch_size,
    },
    memory: {
      rss_start_mb: firstMem.rss_mb,
      rss_end_mb: lastMem.rss_mb,
      heap_used_start_mb: firstMem.heap_used_mb,
      heap_used_end_mb: lastMem.heap_used_mb,
    },
    verdict: totalErrors === 0 ? 'PASS' : 'FAIL',
  }
}
