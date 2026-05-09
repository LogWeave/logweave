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
let readyCache: { ok: boolean; clustererOk: boolean; ts: number } = { ok: false, clustererOk: false, ts: 0 }

export function healthRoutes(deps: HealthDeps): Router {
  const router = Router()

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' })
  })

  router.get('/readyz', async (_req, res) => {
    const now = Date.now()
    const useCache = now - readyCache.ts < READY_CACHE_TTL_MS

    // Active probes — actually contact dependencies. Cache result for READY_CACHE_TTL_MS to avoid hammering.
    // Without an active clusterer ping, consecutiveFailures stays at 0 on a fresh boot even when the clusterer
    // is unreachable, and /readyz lies (reports clusterer 'ok' until first ingest call).
    let chOk: boolean
    let clustererProbeOk: boolean
    if (useCache) {
      chOk = readyCache.ok
      clustererProbeOk = readyCache.clustererOk
    } else {
      ;[chOk, clustererProbeOk] = await Promise.all([
        pingClickHouse(deps.db),
        deps.clustererHealth.check(),
      ])
      readyCache = { ok: chOk, clustererOk: clustererProbeOk, ts: now }
    }

    const consecutiveFailures = deps.clustererHealth.consecutiveFailures
    const clustererStatus = clustererProbeOk
      ? 'ok'
      : consecutiveFailures > 0
        ? 'degraded'
        : 'unreachable'

    res.status(chOk ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: chOk ? 'ready' : 'not_ready',
      clickhouse: chOk ? 'ok' : 'error',
      clusterer: {
        status: clustererStatus,
        consecutiveFailures,
        circuitOpen: deps.clusterClient?.isCircuitOpen ?? false,
      },
      metrics: metrics.snapshot(),
    })
  })

  // GET /metrics — Prometheus exposition format (unauthenticated, like health endpoints)
  // NOTE: counters are in-memory and reset on process restart. Use process_start_time_seconds
  // to detect restarts and exclude the post-restart window from rate() alerts.
  router.get('/metrics', (_req, res) => {
    const snap = metrics.snapshot()
    const uptime = process.uptime()
    const startTimeSecs = Math.floor((Date.now() - uptime * 1000) / 1000)

    const lines: string[] = [
      '# HELP logweave_process_start_time_seconds Unix timestamp when the process started',
      '# TYPE logweave_process_start_time_seconds gauge',
      `logweave_process_start_time_seconds ${startTimeSecs}`,
      '',
      '# HELP logweave_events_ingested_total Total events ingested since last restart',
      '# TYPE logweave_events_ingested_total counter',
      `logweave_events_ingested_total ${snap.events_ingested ?? 0}`,
      '',
      '# HELP logweave_events_dropped_total Events dropped due to parse errors since last restart',
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
      '# HELP logweave_tag_insert_failed_total Tag rows dropped because event_tags insert failed',
      '# TYPE logweave_tag_insert_failed_total counter',
      `logweave_tag_insert_failed_total ${snap.tag_insert_failed ?? 0}`,
      '',
      '# HELP logweave_recovery_tenants_skipped_total Tenants permanently skipped due to repeated recovery DELETE failures',
      '# TYPE logweave_recovery_tenants_skipped_total counter',
      `logweave_recovery_tenants_skipped_total ${snap.recovery_tenants_skipped ?? 0}`,
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
  readyCache = { ok: false, clustererOk: false, ts: 0 }
}
