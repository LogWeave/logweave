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
  /**
   * Vector archive endpoint (LOGWEAVE_VECTOR_ARCHIVE_URL). When set, the public
   * ingest routes forward batches to Vector for durable S3 archival instead of
   * clustering synchronously — the async consumer (#277) clusters off the hot
   * path. When unset, the legacy synchronous cluster+insert path is used.
   */
  vectorArchiveUrl?: string
  /** Injectable fetch for the archive forward (testing). Default: global fetch. */
  archiveFetchFn?: typeof globalThis.fetch
}
