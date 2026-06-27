import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import { batchInsert } from '../db/insert.js'
import { serviceUnavailable } from '../errors.js'
import type { EventBus } from '../events/event-bus.js'
import * as metrics from '../metrics.js'

/** Retry-After (seconds) advertised when ClickHouse is unavailable for ingest. */
const INGEST_RETRY_AFTER_SECONDS = 30

import type { TailBuffer } from '../tail/buffer.js'
import { levelMeetsSeverity } from '../tail/types.js'
import type { LogMetadataRow } from '../types.js'
import { uuidv7 } from '../uuid.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'
import type { AnomalyScorer } from './anomaly-scorer.js'
import type { ClusterClient, ClusterResult } from './cluster-client.js'
import { computeBatchKey, extractEventId, getCachedResult, recordResult } from './idempotency.js'
import { PREPROCESSING_VERSION, parseEvent, processEvent } from './index.js'
import type { ParseOptions, ProcessedEvent } from './types.js'

export interface IngestDependencies {
  clusterClient: ClusterClient
  db: DbClient
  logger: pino.Logger
  anomalyScorer: AnomalyScorer
  tailBuffer?: TailBuffer
  settingsStore?: TenantSettingsStore
  eventBus?: EventBus
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
  raw: unknown
  /** Final dedup id: source-assigned event_id, or a generated UUIDv7 fallback. */
  eventId: string
}

/**
 * Extract timestamp from a raw event object.
 * Checks timestamp, @timestamp, time, date fields.
 * Handles ISO 8601 strings and numeric Unix epoch (seconds or milliseconds).
 */
export function extractTimestamp(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const obj = event as Record<string, unknown>

  for (const key of ['timestamp', '@timestamp', 'time', 'date']) {
    const val = obj[key]
    if (typeof val === 'string' && val.length > 0) {
      const parsed = Date.parse(val)
      if (!Number.isNaN(parsed)) return val
    }
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      // Distinguish seconds (< 1e12) from milliseconds (>= 1e12)
      const ms = val < 1e12 ? val * 1000 : val
      return new Date(ms).toISOString()
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
  options: ParseOptions,
): LogMetadataRow {
  return {
    id: uuidv7(),
    event_id: item.eventId,
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
    source_type: options.sourceType ?? 'transport',
    source_ref: options.sourceRef ?? '',
    pre_processed_message: cluster.templateId === '0' ? item.processed.preProcessedMessage : null,
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
  parser?: import('./types.js').LogParser,
): Promise<IngestResult> {
  const ingestTime = new Date().toISOString()

  // Phase 1: Parse + Preprocess
  let items: ParsedItem[] = []
  let parseErrors = 0
  const sourceEventIds: string[] = []

  for (let i = 0; i < events.length; i++) {
    const result = parseEvent(events[i], i, options, parser)
    if (!result.ok) {
      parseErrors++
      deps.logger.debug({ index: i, error: result.error, tenantId }, 'Skipping unparseable event')
      continue
    }
    const timestamp = extractTimestamp(events[i]) ?? ingestTime
    const processed = processEvent(result.event)
    // event_id is assigned at the source (SDK); generate a UUIDv7 fallback for
    // non-SDK sources so every row has a stable dedup key (#268).
    const sourceEventId = extractEventId(events[i])
    if (sourceEventId) sourceEventIds.push(sourceEventId)
    items.push({ processed, timestamp, raw: events[i], eventId: sourceEventId ?? uuidv7() })
  }

  // Batch idempotency: explicit header key, else a hash of the source-assigned
  // event_ids. A batch with neither has no stable identity — always processed.
  const batchKey =
    options.idempotencyKey ??
    (sourceEventIds.length > 0 ? computeBatchKey(sourceEventIds) : undefined)
  if (batchKey) {
    const cached = getCachedResult(tenantId, batchKey)
    if (cached) {
      deps.logger.debug({ tenantId, batchKey }, 'Idempotent replay — short-circuiting batch')
      return cached
    }
  }

  // Filter by minimum ingest level (server-side log-level gating)
  const minLevel = deps.settingsStore?.get(tenantId).minIngestLevel
  let levelFiltered = 0
  if (minLevel) {
    const before = items.length
    items = items.filter((item) => levelMeetsSeverity(item.processed.level, minLevel))
    levelFiltered = before - items.length
  }

  metrics.increment(metrics.EVENTS_DROPPED, parseErrors + levelFiltered)

  // Early return if all events failed parsing or were filtered
  if (items.length === 0) {
    return { accepted: 0, clustered: 0, unclustered: 0, new_templates: 0 }
  }

  // Phase 2: Cluster (single call with all pre-processed messages)
  const messages = items.map((item) => item.processed.preProcessedMessage)
  const simTh = deps.settingsStore?.get(tenantId).clusteringSensitivity
  const clusterResults = await deps.clusterClient.cluster(tenantId, messages, simTh)

  // Phase 3: Enrich — build LogMetadataRow[]
  const rows: LogMetadataRow[] = []
  let clustered = 0
  let unclustered = 0
  let newTemplates = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const cluster = clusterResults[i]
    if (!item || !cluster) {
      // Parallel-array invariant: clusterResults is built one-to-one from
      // items earlier in this function. If either is missing here, we've
      // hit a programming bug — skip the row rather than crash the batch.
      continue
    }
    const anomalyScore = deps.anomalyScorer.recordAndScore(
      tenantId,
      item.processed.service,
      cluster.templateId,
    )

    rows.push(toMetadataRow(tenantId, item, cluster, anomalyScore, options))

    if (cluster.templateId === '0') {
      unclustered++
    } else {
      clustered++
      if (cluster.isNewTemplate) {
        newTemplates++
      }
    }
  }

  // All items were skipped while building rows (e.g. a clusterer contract breach
  // left no usable results). Nothing to persist — return rather than letting an
  // empty batchInsert throw and be misreported as a retryable 503.
  if (rows.length === 0) {
    return { accepted: 0, clustered, unclustered, new_templates: newTemplates }
  }

  // Phase 4: Write (single batch INSERT). Must succeed before we publish to
  // the event bus or bump metrics — otherwise live-tail viewers see events
  // that aren't actually persisted, and counts inflate when ingest fails and
  // the client retries.
  //
  // Ingest is synchronous with no durable queue (beta scope): a ClickHouse
  // outage means these events are not persisted. Surface that as a clean 503 +
  // Retry-After so @logweave/transport backs off and retries rather than
  // dropping the batch on a generic 5xx. See docs/install.md "Durability".
  const insertStart = Date.now()
  try {
    await batchInsert(deps.db, rows)
  } catch (err) {
    metrics.increment(metrics.INGEST_WRITE_FAILED, rows.length)
    deps.logger.error(
      { err, tenantId, rows: rows.length },
      'ClickHouse ingest write failed — returning 503 Retry-After',
    )
    throw serviceUnavailable(
      'Log storage is temporarily unavailable. Retry after the indicated delay.',
      INGEST_RETRY_AFTER_SECONDS,
    )
  }
  const insertMs = Date.now() - insertStart

  // Phase 4.1: Publish to event bus (live tail, future: NATS cross-instance)
  if (deps.eventBus) {
    for (const row of rows) {
      deps.eventBus.publishTailEvent(tenantId, {
        timestamp: row.timestamp,
        service: row.service,
        level: row.level,
        templateId: row.template_id ?? '0',
        templateText: row.template_text ?? '',
        preProcessedMessage: row.pre_processed_message ?? '',
        anomalyScore: row.anomaly_score ?? 0,
        statusCode: row.status_code ?? 0,
        durationMs: row.duration_ms ?? 0,
        traceId: row.trace_id ?? '',
        route: row.route ?? '',
      })
    }
  }

  // Phase 4.5: Extract configured tags to event_tags table
  const extractTags = deps.settingsStore?.get(tenantId).extractTags
  if (extractTags && extractTags.length > 0) {
    const tagRows: Array<Record<string, unknown>> = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rawEvent = items[i]?.raw
      if (!row || typeof rawEvent !== 'object' || rawEvent === null) continue
      const obj = rawEvent as Record<string, unknown>
      const fields =
        typeof obj.fields === 'object' && obj.fields !== null
          ? (obj.fields as Record<string, unknown>)
          : undefined

      for (const tagKey of extractTags) {
        const value = obj[tagKey] ?? fields?.[tagKey]
        if (value === undefined || value === null) continue
        const strValue = String(value)
        if (strValue.length === 0 || strValue.length > 256) continue

        tagRows.push({
          tenant_id: tenantId,
          event_id: row.id ?? '',
          template_id: row.template_id ?? '0',
          service: row.service,
          level: row.level,
          timestamp: row.timestamp,
          tag_key: tagKey,
          tag_value: strValue,
        })
      }
    }
    if (tagRows.length > 0) {
      try {
        await deps.db.insert({
          table: 'logweave.event_tags',
          values: tagRows,
          format: 'JSONEachRow',
        })
      } catch (err) {
        // Tags become permanently desynced from log_metadata. We don't fail the
        // ingest because metadata write already succeeded, but operators need
        // visibility — bump a counter that's exposed via /metrics so this can
        // be alerted on if the failure rate is non-trivial.
        metrics.increment(metrics.TAG_INSERT_FAILED, tagRows.length)
        deps.logger.error(
          { err, tenantId, tagCount: tagRows.length },
          'Failed to insert event tags — metadata kept, tags dropped',
        )
      }
    }
  }

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

  const result: IngestResult = {
    accepted: items.length,
    clustered,
    unclustered,
    new_templates: newTemplates,
  }

  // Remember the result so an at-least-once replay of this batch replays the
  // same outcome instead of re-inserting. Recorded only after a successful
  // insert, so a retry following a failure still goes through.
  if (batchKey) recordResult(tenantId, batchKey, result)

  return result
}
