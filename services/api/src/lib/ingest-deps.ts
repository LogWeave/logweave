import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import type { EventBus } from '../events/event-bus.js'
import type { AnomalyScorer } from '../pipeline/anomaly-scorer.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'
import type { TailBuffer } from '../tail/buffer.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'

/** Shared dependencies for all ingest routes and the ingest pipeline. */
export interface IngestDeps {
  clusterClient: ClusterClient
  db: DbClient
  logger: pino.Logger
  anomalyScorer: AnomalyScorer
  tailBuffer?: TailBuffer
  settingsStore?: TenantSettingsStore
  eventBus?: EventBus
}
