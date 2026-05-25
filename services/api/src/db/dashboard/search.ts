import type { DbClient } from '../client.js'
import {
  clamp,
  DEFAULT_HOURS,
  DEFAULT_STATS_LIMIT,
  MAX_HOURS,
  MAX_STATS_LIMIT,
  tenantQuery,
} from '../queries.js'
import type { CrossServiceTemplateRow } from './templates.js'

/**
 * Searches template_registry for templates matching a text query, then joins
 * to template_stats for occurrence counts within the time window.
 *
 * Uses SELECT ... FINAL on template_registry (ReplacingMergeTree).
 * Uses ILIKE for case-insensitive substring matching.
 * Returns cross-service aggregated results (same shape as queryTemplatesAcrossServices).
 */
export async function queryTemplateSearch(
  db: DbClient,
  tenantId: string,
  options: { q: string; hours?: number; limit?: number; level?: string[] },
): Promise<CrossServiceTemplateRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const limit = clamp(options.limit ?? DEFAULT_STATS_LIMIT, MAX_STATS_LIMIT)
  const levels = options.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
/* @query: templateSearch */
WITH matching_templates AS (
    SELECT template_id, template_text
    FROM logweave.template_registry FINAL
    WHERE tenant_id = {tenant_id:String}
      AND template_text ILIKE {search_pattern:String}
)
SELECT
    s.template_id,
    any(m.template_text)                AS template_text,
    groupArray(DISTINCT s.service)      AS services_affected,
    countMerge(s.occurrence_count)      AS occurrence_count,
    countMerge(s.error_count)         AS error_count,
    avgMerge(s.avg_duration_ms)         AS avg_duration_ms,
    maxMerge(s.max_anomaly_score)       AS max_anomaly_score,
    min(s.interval_start)               AS first_seen,
    max(s.interval_start)               AS last_seen
FROM logweave.template_stats s
INNER JOIN matching_templates m ON s.template_id = m.template_id
WHERE s.tenant_id = {tenant_id:String}
  AND s.interval_start > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}
GROUP BY s.template_id
ORDER BY occurrence_count DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = {
    hours,
    limit,
    search_pattern: `%${escapeLikePattern(options.q)}%`,
  }
  if (levels?.length) params.levels = levels

  return db.query<CrossServiceTemplateRow>(tenantQuery(query, tenantId, params))
}

// Escape ClickHouse LIKE/ILIKE metacharacters so user input cannot force a
// full table scan via leading wildcards (e.g. "%" or "_") or break the
// surrounding "%...%" wrap with a backslash.
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Semantic template search via cosineDistance on embedding vectors.
 * Same return shape as queryTemplateSearch for drop-in replacement.
 */
export async function querySemanticSearch(
  db: DbClient,
  tenantId: string,
  options: {
    embedding: number[]
    hours?: number
    limit?: number
    level?: string[]
    threshold?: number
  },
): Promise<CrossServiceTemplateRow[]> {
  const hours = clamp(options.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const limit = clamp(options.limit ?? DEFAULT_STATS_LIMIT, MAX_STATS_LIMIT)
  const threshold = options.threshold ?? 0.5
  const levels = options.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
/* @query: semanticSearch */
WITH matching_templates AS (
    SELECT template_id, template_text,
           cosineDistance(embedding, {embedding:Array(Float32)}) AS distance
    FROM logweave.template_registry FINAL
    WHERE tenant_id = {tenant_id:String}
      AND length(embedding) > 0
    HAVING distance < {threshold:Float32}
    ORDER BY distance ASC
    LIMIT {template_limit:UInt32}
)
SELECT
    s.template_id,
    any(m.template_text)                AS template_text,
    groupArray(DISTINCT s.service)      AS services_affected,
    countMerge(s.occurrence_count)      AS occurrence_count,
    countMerge(s.error_count)         AS error_count,
    avgMerge(s.avg_duration_ms)         AS avg_duration_ms,
    maxMerge(s.max_anomaly_score)       AS max_anomaly_score,
    min(s.interval_start)               AS first_seen,
    max(s.interval_start)               AS last_seen
FROM logweave.template_stats s
INNER JOIN matching_templates m ON s.template_id = m.template_id
WHERE s.tenant_id = {tenant_id:String}
  AND s.interval_start > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}
GROUP BY s.template_id
ORDER BY occurrence_count DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = {
    hours,
    limit,
    embedding: options.embedding,
    threshold,
    template_limit: limit * 2,
  }
  if (levels?.length) params.levels = levels

  return db.query<CrossServiceTemplateRow>(tenantQuery(query, tenantId, params))
}
