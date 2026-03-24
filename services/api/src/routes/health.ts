import { Router } from 'express'
import { pingClickHouse } from '../clients/clickhouse.js'
import type { ClustererHealthChecker } from '../clients/clusterer.js'
import type { DbClient } from '../db/client.js'
import { HttpStatus } from '../http-status.js'
import * as metrics from '../metrics.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'

interface HealthDeps {
  db: DbClient
  clustererHealth: ClustererHealthChecker
  clusterClient?: ClusterClient
}

const READY_CACHE_TTL_MS = 5_000
let readyCache: { ok: boolean; ts: number } = { ok: false, ts: 0 }

export function healthRoutes(deps: HealthDeps): Router {
  const router = Router()

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' })
  })

  router.get('/readyz', async (_req, res) => {
    const now = Date.now()

    // Use cached result if fresh (caches both success and failure to prevent hammering)
    if (now - readyCache.ts < READY_CACHE_TTL_MS) {
      const clustererStatus = deps.clustererHealth.consecutiveFailures === 0 ? 'ok' : 'degraded'
      res.status(readyCache.ok ? 200 : HttpStatus.SERVICE_UNAVAILABLE).json({
        status: readyCache.ok ? 'ready' : 'not_ready',
        clickhouse: readyCache.ok ? 'ok' : 'error',
        clusterer: {
          status: clustererStatus,
          consecutiveFailures: deps.clustererHealth.consecutiveFailures,
          circuitOpen: deps.clusterClient?.isCircuitOpen ?? false,
        },
        metrics: metrics.snapshot(),
      })
      return
    }

    const chOk = await pingClickHouse(deps.db)
    readyCache = { ok: chOk, ts: now }

    const clustererStatus = deps.clustererHealth.consecutiveFailures === 0 ? 'ok' : 'degraded'

    if (!chOk) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'not_ready',
        clickhouse: 'error',
        clusterer: {
          status: clustererStatus,
          consecutiveFailures: deps.clustererHealth.consecutiveFailures,
          circuitOpen: deps.clusterClient?.isCircuitOpen ?? false,
        },
        metrics: metrics.snapshot(),
      })
      return
    }

    res.json({
      status: 'ready',
      clickhouse: 'ok',
      clusterer: {
        status: clustererStatus,
        consecutiveFailures: deps.clustererHealth.consecutiveFailures,
        circuitOpen: deps.clusterClient?.isCircuitOpen ?? false,
      },
      metrics: metrics.snapshot(),
    })
  })

  // GET /metrics — Prometheus exposition format (unauthenticated, like health endpoints)
  router.get('/metrics', (_req, res) => {
    const snap = metrics.snapshot()
    const uptime = process.uptime()

    const lines: string[] = [
      '# HELP logweave_events_ingested_total Total events ingested',
      '# TYPE logweave_events_ingested_total counter',
      `logweave_events_ingested_total ${snap.events_ingested ?? 0}`,
      '',
      '# HELP logweave_events_dropped_total Events dropped due to parse errors',
      '# TYPE logweave_events_dropped_total counter',
      `logweave_events_dropped_total ${snap.events_dropped ?? 0}`,
      '',
      '# HELP logweave_events_clustered_total Events successfully clustered',
      '# TYPE logweave_events_clustered_total counter',
      `logweave_events_clustered_total ${snap.events_clustered ?? 0}`,
      '',
      '# HELP logweave_events_unclustered_total Events that failed clustering',
      '# TYPE logweave_events_unclustered_total counter',
      `logweave_events_unclustered_total ${snap.events_unclustered ?? 0}`,
      '',
      '# HELP logweave_new_templates_total New templates discovered',
      '# TYPE logweave_new_templates_total counter',
      `logweave_new_templates_total ${snap.new_templates ?? 0}`,
      '',
      '# HELP logweave_insert_count_total Total ClickHouse inserts',
      '# TYPE logweave_insert_count_total counter',
      `logweave_insert_count_total ${snap.insert_count ?? 0}`,
      '',
      '# HELP logweave_insert_latency_ms_total Cumulative insert latency in ms',
      '# TYPE logweave_insert_latency_ms_total counter',
      `logweave_insert_latency_ms_total ${snap.insert_latency_ms_total ?? 0}`,
      '',
      '# HELP logweave_batch_size_total Cumulative batch size across all inserts',
      '# TYPE logweave_batch_size_total counter',
      `logweave_batch_size_total ${snap.batch_size_total ?? 0}`,
      '',
      '# HELP logweave_anomaly_scored_total Events with anomaly score > 0',
      '# TYPE logweave_anomaly_scored_total counter',
      `logweave_anomaly_scored_total ${snap.anomaly_scored ?? 0}`,
      '',
      '# HELP logweave_recovery_recovered_total Events recovered by sweep',
      '# TYPE logweave_recovery_recovered_total counter',
      `logweave_recovery_recovered_total ${snap.recovery_recovered ?? 0}`,
      '',
      '# HELP logweave_recovery_failed_total Recovery attempts that failed',
      '# TYPE logweave_recovery_failed_total counter',
      `logweave_recovery_failed_total ${snap.recovery_failed ?? 0}`,
      '',
      '# HELP logweave_process_uptime_seconds Process uptime',
      '# TYPE logweave_process_uptime_seconds gauge',
      `logweave_process_uptime_seconds ${uptime.toFixed(0)}`,
      '',
      '# HELP logweave_insert_avg_latency_ms Average insert latency (derived)',
      '# TYPE logweave_insert_avg_latency_ms gauge',
      `logweave_insert_avg_latency_ms ${(snap.insert_count ?? 0) > 0 ? ((snap.insert_latency_ms_total ?? 0) / (snap.insert_count ?? 1)).toFixed(1) : 0}`,
      '',
    ]

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(lines.join('\n'))
  })

  return router
}

/** Reset cache — for testing only */
export function _resetReadyCache(): void {
  readyCache = { ok: false, ts: 0 }
}
