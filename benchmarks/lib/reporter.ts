import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  BenchmarkReport,
  RegressionItem,
  ScenarioResult,
  TransportResult,
} from './types.js'
import { getGitBranch, getGitSha } from './runner.js'

/** Build the full benchmark report from collected results. */
export function buildReport(
  apiResults: readonly ScenarioResult[],
  transportResults: readonly TransportResult[],
  tier: string,
): BenchmarkReport {
  const all = [
    ...apiResults.map((r) => r.verdict),
    ...transportResults.map((r) => r.verdict),
  ]
  const allEventsPerSec = [
    ...apiResults.map((r) => r.results.events_per_second),
    ...transportResults.map((r) => r.results.events_per_second),
  ]

  return {
    meta: {
      timestamp: new Date().toISOString(),
      git_sha: getGitSha(),
      git_branch: getGitBranch(),
      node_version: process.version,
      platform: `${process.platform} ${process.arch}`,
      tier,
    },
    api_scenarios: apiResults,
    transport_scenarios: transportResults,
    summary: {
      total_scenarios: all.length,
      passed: all.filter((v) => v === 'PASS').length,
      failed: all.filter((v) => v === 'FAIL').length,
      skipped: all.filter((v) => v === 'SKIP').length,
      peak_events_per_second: allEventsPerSec.length > 0 ? Math.max(...allEventsPerSec) : 0,
    },
  }
}

/** Compare current results against a baseline file. Returns regressions and improvements. */
export function compareBaseline(
  current: BenchmarkReport,
  baselinePath: string,
  thresholds: { throughput_drop_pct: number; p99_increase_pct: number },
): { regressions: RegressionItem[]; improvements: RegressionItem[] } {
  const regressions: RegressionItem[] = []
  const improvements: RegressionItem[] = []

  let baseline: BenchmarkReport
  try {
    const raw = readFileSync(resolve(baselinePath), 'utf8')
    baseline = JSON.parse(raw) as BenchmarkReport
  } catch {
    console.warn(`  ⚠ Could not read baseline: ${baselinePath}`)
    return { regressions, improvements }
  }

  const baselineMap = new Map<string, ScenarioResult>()
  for (const s of baseline.api_scenarios) {
    baselineMap.set(s.name, s)
  }

  for (const current_scenario of current.api_scenarios) {
    const base = baselineMap.get(current_scenario.name)
    if (!base) continue

    // Throughput: regression = decrease
    const throughputChange =
      ((current_scenario.results.events_per_second - base.results.events_per_second) /
        base.results.events_per_second) *
      100
    const throughputItem: RegressionItem = {
      scenario: current_scenario.name,
      metric: 'events_per_second',
      baseline: base.results.events_per_second,
      current: current_scenario.results.events_per_second,
      change_pct: Math.round(throughputChange * 10) / 10,
    }
    if (throughputChange < -thresholds.throughput_drop_pct) {
      regressions.push(throughputItem)
    } else if (throughputChange > thresholds.throughput_drop_pct) {
      improvements.push(throughputItem)
    }

    // Latency p99: regression = increase
    const p99Change =
      ((current_scenario.results.latency_ms.p99 - base.results.latency_ms.p99) /
        base.results.latency_ms.p99) *
      100
    const p99Item: RegressionItem = {
      scenario: current_scenario.name,
      metric: 'latency_p99_ms',
      baseline: base.results.latency_ms.p99,
      current: current_scenario.results.latency_ms.p99,
      change_pct: Math.round(p99Change * 10) / 10,
    }
    if (p99Change > thresholds.p99_increase_pct) {
      regressions.push(p99Item)
    } else if (p99Change < -thresholds.p99_increase_pct) {
      improvements.push(p99Item)
    }
  }

  return { regressions, improvements }
}

/** Print a human-readable summary table to console. */
export function printReport(report: BenchmarkReport): void {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  console.log('║                  LogWeave Benchmark Results                     ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')
  console.log(`  Timestamp:  ${report.meta.timestamp}`)
  console.log(`  Git:        ${report.meta.git_sha} (${report.meta.git_branch})`)
  console.log(`  Node:       ${report.meta.node_version}`)
  console.log(`  Tier:       ${report.meta.tier}`)
  console.log(`  Platform:   ${report.meta.platform}\n`)

  if (report.api_scenarios.length > 0) {
    console.log('  ┌─ API Scenarios ─────────────────────────────────────────────┐')
    console.log(
      '  │ Name                        │ ev/s     │ p50   │ p99   │ Err │',
    )
    console.log(
      '  ├─────────────────────────────┼──────────┼───────┼───────┼─────┤',
    )
    for (const s of report.api_scenarios) {
      const name = s.name.padEnd(27)
      const eps = Math.round(s.results.events_per_second).toString().padStart(8)
      const p50 = s.results.latency_ms.p50.toFixed(1).padStart(5)
      const p99 = s.results.latency_ms.p99.toFixed(1).padStart(5)
      const err = s.results.errors.toString().padStart(3)
      const icon = s.verdict === 'PASS' ? ' ' : s.verdict === 'FAIL' ? '!' : '-'
      console.log(`  │${icon}${name} │ ${eps} │ ${p50} │ ${p99} │ ${err} │`)
    }
    console.log(
      '  └─────────────────────────────┴──────────┴───────┴───────┴─────┘\n',
    )
  }

  if (report.transport_scenarios.length > 0) {
    console.log('  ┌─ Transport Scenarios ───────────────────────────────────────┐')
    console.log(
      '  │ Name                        │ ev/s     │ Drop  │ Dur(s)│     │',
    )
    console.log(
      '  ├─────────────────────────────┼──────────┼───────┼───────┼─────┤',
    )
    for (const s of report.transport_scenarios) {
      const name = s.name.padEnd(27)
      const eps = Math.round(s.results.events_per_second).toString().padStart(8)
      const drop = s.results.dropped_events.toString().padStart(5)
      const dur = (s.results.duration_ms / 1000).toFixed(1).padStart(5)
      const icon = s.verdict === 'PASS' ? ' ' : s.verdict === 'FAIL' ? '!' : '-'
      console.log(`  │${icon}${name} │ ${eps} │ ${drop} │ ${dur} │     │`)
    }
    console.log(
      '  └─────────────────────────────┴──────────┴───────┴───────┴─────┘\n',
    )
  }

  const s = report.summary
  console.log(`  Summary: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`)
  console.log(`  Peak throughput: ${Math.round(s.peak_events_per_second).toLocaleString()} events/sec`)

  if (s.baseline_comparison) {
    const bc = s.baseline_comparison
    if (bc.regressions.length > 0) {
      console.log('\n  ⚠ REGRESSIONS:')
      for (const r of bc.regressions) {
        console.log(`    ${r.scenario} → ${r.metric}: ${r.change_pct > 0 ? '+' : ''}${r.change_pct}%`)
      }
    }
    if (bc.improvements.length > 0) {
      console.log('\n  ✓ IMPROVEMENTS:')
      for (const r of bc.improvements) {
        console.log(`    ${r.scenario} → ${r.metric}: ${r.change_pct > 0 ? '+' : ''}${r.change_pct}%`)
      }
    }
    if (bc.regressions.length === 0 && bc.improvements.length === 0) {
      console.log('\n  ─ No significant changes from baseline')
    }
  }
  console.log()
}

/** Write the report as JSON to a file. */
export function writeReport(report: BenchmarkReport, outPath: string): void {
  const fullPath = resolve(outPath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(`  Report written to: ${outPath}`)
}
