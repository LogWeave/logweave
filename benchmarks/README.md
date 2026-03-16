# LogWeave Benchmarks

Black-box performance benchmarks for the LogWeave platform. Measures HTTP endpoint throughput, latency percentiles, memory usage, and transport SDK performance.

## Design Principles

- **Refactor-proof** — benchmarks hit HTTP endpoints with raw JSON payloads, never import internal modules. Rename anything in `src/` — zero benchmark changes.
- **Config-driven** — scenarios defined in `config/scenarios.json`. Adding a new scenario = ~8 lines of JSON, no code.
- **LLM-interpretable** — JSON output includes descriptions, configs, metrics, and verdicts. An LLM can read the report and identify regressions.

## Prerequisites

- Docker ClickHouse running: `docker compose up clickhouse -d`
- Dependencies installed: `pnpm install` (from repo root)

## Usage

```bash
# Run all benchmarks (Tier 1 — mock clusterer, real ClickHouse)
pnpm benchmark

# Run with full Docker Compose stack (Tier 2)
pnpm benchmark --tier full

# Filter scenarios
pnpm benchmark --filter 'ingest-*'      # API scenarios only
pnpm benchmark --filter 'transport-*'   # Transport scenarios only
pnpm benchmark --tag long               # Long-running scenarios only

# Compare against baseline
pnpm benchmark --compare docs/benchmarks/baseline-week1b.json

# Via dev.sh
./dev.sh benchmark
./dev.sh benchmark --filter 'ingest-batch-100*'
```

## Tiers

### Tier 1 — Mock Clusterer (default)

The harness starts:
1. A mock clusterer (`node:http` server on port 8001, <1ms response)
2. The real API server (on port 3001, pointed at mock clusterer + Docker ClickHouse)
3. Runs autocannon against the API

This isolates the API server's own performance from Python/Drain3 variability. You only need Docker ClickHouse running.

### Tier 2 — Full Stack (`--tier full`)

Expects the full Docker Compose stack running (`docker compose up --build`). Benchmarks hit the production API on port 3000 with the real clusterer. Use this for pre-release validation.

## Scenarios

### API Scenarios (8)

| Name | Batch | Conn | Duration | Purpose |
|------|-------|------|----------|---------|
| `ingest-batch-10-c1` | 10 | 1 | 30s | Latency baseline |
| `ingest-batch-100-c10` | 100 | 10 | 30s | Typical SDK flush |
| `ingest-batch-500-c10` | 500 | 10 | 30s | Large batch throughput |
| `ingest-batch-1000-c10` | 1000 | 10 | 30s | Max batch size |
| `sustained-500eps-5min` | 100 | 5 | 5min | Memory leak detection |
| `burst-5000-events` | 1000 | 5 | 5 reqs | Burst recovery |
| `multi-tenant-10x100` | 100 | 10 | 60s | Tenant isolation |
| `clusterer-down` | 100 | 10 | 60s | Degradation impact |

### Transport Scenarios (3)

| Name | Events | Mock Latency | Purpose |
|------|--------|-------------|---------|
| `transport-throughput` | 100K | 0ms | Max SDK throughput |
| `transport-slow-api` | 50K | 200ms | Backpressure |
| `transport-api-down` | 10K | reject | Drop handling |

## Output

Results are written to `benchmarks/results/<timestamp>.json` (gitignored) and printed to console.

### JSON Report Structure

```json
{
  "meta": { "timestamp", "git_sha", "node_version", "tier", "platform" },
  "api_scenarios": [{
    "name": "ingest-batch-100-c10",
    "description": "...",
    "config": { "batch_size": 100, "connections": 10 },
    "results": {
      "requests_per_second": 245.3,
      "events_per_second": 24530,
      "latency_ms": { "p50": 38.2, "p95": 72.1, "p99": 128.4, "max": 312.7 }
    },
    "memory": { "rss_start_mb", "rss_end_mb", "heap_used_start_mb", "heap_used_end_mb" },
    "verdict": "PASS"
  }],
  "transport_scenarios": [{ ... }],
  "summary": { "total_scenarios", "passed", "failed", "peak_events_per_second" }
}
```

### Regression Detection

When using `--compare`, the harness compares against a baseline JSON file:
- **Throughput drop > 10%** → flagged as regression
- **p99 latency increase > 20%** → flagged as regression

If any regressions are found, the process exits with code 1.

## Adding Scenarios

Edit `config/scenarios.json`. Example — add a 50-connection stress test:

```json
{
  "name": "ingest-stress-c50",
  "description": "50 concurrent connections, medium batches — stress test",
  "endpoint": "/v1/ingest/batch",
  "method": "POST",
  "batch_size": 100,
  "connections": 50,
  "duration_seconds": 60,
  "headers": { "Authorization": "Bearer bench-key" },
  "tags": ["stress"]
}
```

No code changes needed. Run with `pnpm benchmark --filter 'ingest-stress*'`.

## Architecture

```
benchmarks/
├── run.ts                CLI entrypoint (--tier, --filter, --tag, --compare)
├── config/
│   └── scenarios.json    All scenario definitions (config-driven)
├── api/
│   ├── mock-clusterer.ts node:http server, <1ms, matches ClustererResponse
│   ├── fixtures.ts       Pre-generates JSON payloads from E2E log generator
│   └── harness.ts        autocannon integration (warm-up + N runs + median)
├── transport/
│   └── harness.ts        SDK benchmark with mock fetch (throughput/memory)
├── lib/
│   ├── types.ts          All TypeScript interfaces
│   ├── runner.ts         Server lifecycle, health checks, statistics
│   ├── memory.ts         Memory snapshot utilities
│   └── reporter.ts       JSON output + console table + baseline comparison
└── results/              JSON output (gitignored)
```

## Statistical Methodology

- **Warm-up:** One autocannon run (configurable duration) before measurement. Discarded. Ensures V8 JIT is warm.
- **Measured runs:** 3 runs per scenario (configurable). Median used by default (robust to GC outliers).
- **Duration:** 30s per scenario minimum. 120s+ for memory leak detection.
- **Thresholds:** 10% throughput / 20% p99 for regression detection. Configurable in `scenarios.json`.
