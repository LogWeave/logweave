import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import { batchInsert } from '../db/insert.js'
import * as metrics from '../metrics.js'
import type { LogMetadataRow } from '../types.js'
import type { AnomalyScorer } from './anomaly-scorer.js'
import type { ClusterClient, ClusterResult } from './cluster-client.js'
import { parseEvent, processEvent, PREPROCESSING_VERSION } from './index.js'
import type { ParseOptions, ProcessedEvent } from './types.js'

export interface IngestDependencies {
  clusterClient: ClusterClient
  db: DbClient
  logger: pino.Logger
  anomalyScorer: AnomalyScorer
}

export interface IngestResult {
  accepted: number
  clustered: number
  unclustered: number
  new_templates: number
}

interface ParsedItem {
  processed: ProcessedEvent
  timestamp: string
}

/**
 * Extract timestamp from a raw event object.
 * Checks timestamp, @timestamp, time fields for ISO 8601 strings.
 */
export function extractTimestamp(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const obj = event as Record<string, unknown>

  for (const key of ['timestamp', '@timestamp', 'time']) {
    const val = obj[key]
    if (typeof val === 'string' && val.length > 0) {
      // Validate with Date.parse — invalid dates return NaN
      // Prevents malformed strings from killing the entire ClickHouse batch INSERT
      const parsed = Date.parse(val)
      if (!Number.isNaN(parsed)) return val
    }
  }
  return undefined
}

/**
 * Build a LogMetadataRow from pipeline types.
 * Maps camelCase pipeline types to snake_case ClickHouse columns.
 */
function toMetadataRow(
  tenantId: string,
  item: ParsedItem,
  cluster: ClusterResult,
  anomalyScore: number,
): LogMetadataRow {
  return {
    tenant_id: tenantId,
    timestamp: item.timestamp,
    service: item.processed.service,
    level: item.processed.level.toUpperCase(),
    environment: item.processed.environment,
    template_id: cluster.templateId,
    template_text: cluster.templateText,
    is_new_template: cluster.isNewTemplate ? 1 : 0,
    anomaly_score: anomalyScore,
    status_code: item.processed.statusCode ?? 0,
    duration_ms: item.processed.durationMs ?? 0,
    trace_id: item.processed.traceId ?? '',
    route: item.processed.route ?? '',
    source_type: 'transport',
    source_ref: '',
    pre_processed_message:
      cluster.templateId === '0' ? item.processed.preProcessedMessage : null,
    preprocessing_version: PREPROCESSING_VERSION,
  }
}

/**
 * Ingest a batch of log events through the 4-phase pipeline.
 * Phase 1: Parse + preprocess (sync, per-event)
 * Phase 2: Cluster (single HTTP call)
 * Phase 3: Enrich (sync, per-event)
 * Phase 4: Write (single batch INSERT)
 */
export async function ingestBatch(
  deps: IngestDependencies,
  tenantId: string,
  events: unknown[],
  options: ParseOptions,
): Promise<IngestResult> {
  const ingestTime = new Date().toISOString()

  // Phase 1: Parse + Preprocess
  const items: ParsedItem[] = []
  let parseErrors = 0

  for (let i = 0; i < events.length; i++) {
    const result = parseEvent(events[i], i, options)
    if (!result.ok) {
      parseErrors++
      deps.logger.debug(
        { index: i, error: result.error, tenantId },
        'Skipping unparseable event',
      )
      continue
    }
    const timestamp = extractTimestamp(events[i]) ?? ingestTime
    const processed = processEvent(result.event)
    items.push({ processed, timestamp })
  }

  metrics.increment(metrics.EVENTS_DROPPED, parseErrors)

  // Early return if all events failed parsing
  if (items.length === 0) {
    return { accepted: 0, clustered: 0, unclustered: 0, new_templates: 0 }
  }

  // Phase 2: Cluster (single call with all pre-processed messages)
  const messages = items.map((item) => item.processed.preProcessedMessage)
  const clusterResults = await deps.clusterClient.cluster(tenantId, messages)

  // Phase 3: Enrich — build LogMetadataRow[]
  const rows: LogMetadataRow[] = []
  let clustered = 0
  let unclustered = 0
  let newTemplates = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const cluster = clusterResults[i]!
    const anomalyScore = deps.anomalyScorer.recordAndScore(
      tenantId,
      item.processed.service,
      cluster.templateId,
    )

    rows.push(toMetadataRow(tenantId, item, cluster, anomalyScore))

    if (cluster.templateId === '0') {
      unclustered++
    } else {
      clustered++
      if (cluster.isNewTemplate) {
        newTemplates++
      }
    }
  }

  // Phase 4: Write (single batch INSERT)
  const insertStart = Date.now()
  await batchInsert(deps.db, rows)
  const insertMs = Date.now() - insertStart

  // Update global metrics
  metrics.increment(metrics.EVENTS_INGESTED, items.length)
  metrics.increment(metrics.EVENTS_CLUSTERED, clustered)
  metrics.increment(metrics.EVENTS_UNCLUSTERED, unclustered)
  metrics.increment(metrics.NEW_TEMPLATES, newTemplates)
  metrics.increment(metrics.INSERT_LATENCY_MS_TOTAL, insertMs)
  metrics.increment(metrics.INSERT_COUNT)
  metrics.increment(metrics.BATCH_SIZE_TOTAL, rows.length)
  const anomalyCount = rows.filter((r) => (r.anomaly_score ?? 0) > 0).length
  if (anomalyCount > 0) {
    metrics.increment(metrics.ANOMALY_SCORED, anomalyCount)
  }

  return {
    accepted: items.length,
    clustered,
    unclustered,
    new_templates: newTemplates,
  }
}
