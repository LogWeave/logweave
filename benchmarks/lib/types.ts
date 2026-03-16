/** Scenario definition from config/scenarios.json */
export interface ApiScenario {
  readonly name: string
  readonly description: string
  readonly endpoint: string
  readonly method: string
  readonly batch_size: number
  readonly connections: number
  readonly duration_seconds?: number
  readonly amount?: number
  readonly headers: Record<string, string>
  readonly tags?: readonly string[]
  readonly multi_tenant?: boolean
  readonly tenant_count?: number
  readonly clusterer_mode?: 'up' | 'down'
}

export interface TransportScenario {
  readonly name: string
  readonly description: string
  readonly event_count: number
  readonly buffer_size: number
  readonly flush_interval_ms: number
  readonly mock_response_ms: number // -1 = reject
}

export interface BenchmarkConfig {
  readonly defaults: {
    readonly warm_up_seconds: number
    readonly measured_runs: number
    readonly stat_aggregation: 'median' | 'mean'
  }
  readonly regression_thresholds: {
    readonly throughput_drop_pct: number
    readonly p99_increase_pct: number
  }
  readonly api_scenarios: readonly ApiScenario[]
  readonly transport_scenarios: readonly TransportScenario[]
}

/** Result of a single measured run */
export interface LatencyMs {
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly average: number
}

export interface MemorySnapshot {
  readonly rss_mb: number
  readonly heap_used_mb: number
}

export interface ScenarioResult {
  readonly name: string
  readonly description: string
  readonly config: Record<string, unknown>
  readonly results: {
    readonly requests_per_second: number
    readonly events_per_second: number
    readonly latency_ms: LatencyMs
    readonly errors: number
    readonly timeouts: number
    readonly total_requests: number
    readonly total_events: number
  }
  readonly memory: {
    readonly rss_start_mb: number
    readonly rss_end_mb: number
    readonly heap_used_start_mb: number
    readonly heap_used_end_mb: number
  }
  readonly verdict: 'PASS' | 'FAIL' | 'SKIP'
}

export interface TransportResult {
  readonly name: string
  readonly description: string
  readonly config: Record<string, unknown>
  readonly results: {
    readonly events_per_second: number
    readonly total_events: number
    readonly total_batches: number
    readonly dropped_events: number
    readonly duration_ms: number
  }
  readonly memory: {
    readonly rss_start_mb: number
    readonly rss_end_mb: number
    readonly heap_used_start_mb: number
    readonly heap_used_end_mb: number
  }
  readonly verdict: 'PASS' | 'FAIL' | 'SKIP'
}

export interface RegressionItem {
  readonly scenario: string
  readonly metric: string
  readonly baseline: number
  readonly current: number
  readonly change_pct: number
}

export interface BenchmarkReport {
  readonly meta: {
    readonly timestamp: string
    readonly git_sha: string
    readonly git_branch: string
    readonly node_version: string
    readonly platform: string
    readonly tier: string
  }
  readonly api_scenarios: readonly ScenarioResult[]
  readonly transport_scenarios: readonly TransportResult[]
  readonly summary: {
    readonly total_scenarios: number
    readonly passed: number
    readonly failed: number
    readonly skipped: number
    readonly peak_events_per_second: number
    readonly baseline_comparison?: {
      readonly baseline_file: string
      readonly regressions: readonly RegressionItem[]
      readonly improvements: readonly RegressionItem[]
    }
  }
}

/** CLI options parsed from process.argv */
export interface CliOptions {
  readonly tier: 'mock' | 'full'
  readonly filter?: string
  readonly tag?: string
  readonly compare?: string
}
