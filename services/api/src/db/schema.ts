import type { ClickHouseClient } from '@clickhouse/client'
import type pino from 'pino'

const DDL_STATEMENTS = [
  // 1. Create database (idempotent)
  `CREATE DATABASE IF NOT EXISTS logweave`,

  // 2. Primary fact table
  `CREATE TABLE IF NOT EXISTS logweave.log_metadata (
    id                     UUID DEFAULT generateUUIDv7(),
    tenant_id              LowCardinality(String),
    timestamp              DateTime64(3),
    ingest_time            DateTime64(3) DEFAULT now64(3),
    service                LowCardinality(String),
    level                  LowCardinality(String),
    environment            LowCardinality(String),
    template_id            String DEFAULT '0',
    template_text          String DEFAULT '',
    is_new_template        UInt8 DEFAULT 0,
    anomaly_score          Float32 DEFAULT 0,
    status_code            UInt16 DEFAULT 0,
    duration_ms            Float64 DEFAULT 0,
    trace_id               String DEFAULT '',
    route                  LowCardinality(String) DEFAULT '',
    source_type            LowCardinality(String),
    source_ref             String,
    pre_processed_message  Nullable(String),
    preprocessing_version  UInt8 DEFAULT 1,
    INDEX idx_level level TYPE set(5) GRANULARITY 1,
    INDEX idx_template_id template_id TYPE bloom_filter(0.01) GRANULARITY 1
  ) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(timestamp)
  ORDER BY (tenant_id, service, timestamp, level)
  TTL toDateTime(timestamp) + toIntervalDay(30) DELETE
  SETTINGS
      index_granularity = 8192,
      ttl_only_drop_parts = 1`,

  // 3. Template stats target table (AggregatingMergeTree)
  `CREATE TABLE IF NOT EXISTS logweave.template_stats (
    tenant_id       LowCardinality(String),
    service         LowCardinality(String),
    template_id     String,
    template_text   String,
    level           LowCardinality(String),
    interval_start  DateTime64(3),
    occurrence_count    AggregateFunction(count),
    error_count         AggregateFunction(countIf, UInt8),
    avg_duration_ms     AggregateFunction(avg, Float64),
    max_anomaly_score   AggregateFunction(max, Float32)
  ) ENGINE = AggregatingMergeTree()
  PARTITION BY toYYYYMM(interval_start)
  ORDER BY (tenant_id, service, template_id, interval_start)
  TTL toDateTime(interval_start) + toIntervalDay(30) DELETE
  SETTINGS ttl_only_drop_parts = 1`,

  // 4. Template stats MV — excludes unclustered rows
  // template_text in GROUP BY (1:1 with template_id) — avoids anyState/anyMerge
  `CREATE MATERIALIZED VIEW IF NOT EXISTS logweave.template_stats_mv
  TO logweave.template_stats AS
  SELECT
      tenant_id, service, template_id, template_text, level,
      toStartOfFiveMinutes(timestamp)   AS interval_start,
      countState()                      AS occurrence_count,
      countIfState(level = 'ERROR')     AS error_count,
      avgState(duration_ms)             AS avg_duration_ms,
      maxState(anomaly_score)           AS max_anomaly_score
  FROM logweave.log_metadata
  WHERE template_id != '0'
  GROUP BY tenant_id, service, template_id, template_text, level, interval_start`,

  // 5. Service stats target table
  `CREATE TABLE IF NOT EXISTS logweave.service_stats (
    tenant_id       LowCardinality(String),
    service         LowCardinality(String),
    level           LowCardinality(String),
    interval_start  DateTime64(3),
    log_count           AggregateFunction(count),
    error_count         AggregateFunction(countIf, UInt8),
    warn_count          AggregateFunction(countIf, UInt8),
    new_template_count  AggregateFunction(countIf, UInt8),
    avg_anomaly_score   AggregateFunction(avg, Float32)
  ) ENGINE = AggregatingMergeTree()
  PARTITION BY toYYYYMM(interval_start)
  ORDER BY (tenant_id, service, interval_start)
  TTL toDateTime(interval_start) + toIntervalDay(30) DELETE
  SETTINGS ttl_only_drop_parts = 1`,

  // 6. Service stats MV — all rows including unclustered
  `CREATE MATERIALIZED VIEW IF NOT EXISTS logweave.service_stats_mv
  TO logweave.service_stats AS
  SELECT
      tenant_id, service, level,
      toStartOfHour(timestamp) AS interval_start,
      countState()                      AS log_count,
      countIfState(level = 'ERROR')     AS error_count,
      countIfState(level = 'WARN')      AS warn_count,
      countIfState(is_new_template = 1) AS new_template_count,
      avgState(anomaly_score)           AS avg_anomaly_score
  FROM logweave.log_metadata
  GROUP BY tenant_id, service, level, interval_start`,

  // 7. Watches — persisted template watches per tenant
  `CREATE TABLE IF NOT EXISTS logweave.watches (
    tenant_id      LowCardinality(String),
    template_id    String,
    template_text  String DEFAULT '',
    version        UInt64,
    is_deleted     UInt8 DEFAULT 0
  ) ENGINE = ReplacingMergeTree(version, is_deleted)
  ORDER BY (tenant_id, template_id)`,

  // 8. Tenant settings — key-value config per tenant (Slack webhook, etc.)
  `CREATE TABLE IF NOT EXISTS logweave.tenant_settings (
    tenant_id      LowCardinality(String),
    setting_key    LowCardinality(String),
    setting_value  String DEFAULT '',
    version        UInt64,
    is_deleted     UInt8 DEFAULT 0
  ) ENGINE = ReplacingMergeTree(version, is_deleted)
  ORDER BY (tenant_id, setting_key)`,
]

// Migrations — add columns that may be missing from older schema versions.
// ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent.
const MIGRATIONS = [
  `ALTER TABLE logweave.log_metadata ADD COLUMN IF NOT EXISTS preprocessing_version UInt8 DEFAULT 1`,

  // Level dimension in template_stats MV
  `DROP VIEW IF EXISTS logweave.template_stats_mv`,
  `ALTER TABLE logweave.template_stats ADD COLUMN IF NOT EXISTS level LowCardinality(String) DEFAULT ''`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS logweave.template_stats_mv
TO logweave.template_stats AS
SELECT
    tenant_id, service, template_id, template_text, level,
    toStartOfFiveMinutes(timestamp) AS interval_start,
    countState()                    AS occurrence_count,
    countIfState(level = 'ERROR')   AS error_count,
    avgState(duration_ms)           AS avg_duration_ms,
    maxState(anomaly_score)         AS max_anomaly_score
FROM logweave.log_metadata
WHERE template_id != '0'
GROUP BY tenant_id, service, template_id, template_text, level, interval_start`,

  // Level dimension in service_stats MV
  `DROP VIEW IF EXISTS logweave.service_stats_mv`,
  `ALTER TABLE logweave.service_stats ADD COLUMN IF NOT EXISTS level LowCardinality(String) DEFAULT ''`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS logweave.service_stats_mv
TO logweave.service_stats AS
SELECT
    tenant_id, service, level,
    toStartOfHour(timestamp) AS interval_start,
    countState()                      AS log_count,
    countIfState(level = 'ERROR')     AS error_count,
    countIfState(level = 'WARN')      AS warn_count,
    countIfState(is_new_template = 1) AS new_template_count,
    avgState(anomaly_score)           AS avg_anomaly_score
FROM logweave.log_metadata
GROUP BY tenant_id, service, level, interval_start`,

  // ngram skip index on template_registry for text search (co-owned with clusterer)
  `ALTER TABLE logweave.template_registry ADD INDEX IF NOT EXISTS idx_template_text_ngram
   template_text TYPE ngrambf_v1(3, 512, 2, 0) GRANULARITY 1`,
]

const RESOURCE_GUARDRAILS = `ALTER USER default SETTINGS
    max_execution_time = 30,
    max_memory_usage = 1073741824,
    max_rows_to_read = 10000000`

const MAX_RETRIES = 5
const INITIAL_BACKOFF_MS = 200

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function initSchema(client: ClickHouseClient, logger: pino.Logger): Promise<void> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      for (const ddl of DDL_STATEMENTS) {
        await client.command({ query: ddl })
      }

      // Run idempotent migrations for existing tables
      for (const migration of MIGRATIONS) {
        await client.command({ query: migration })
      }

      // Resource guardrails are best-effort — ALTER USER may require admin privileges
      try {
        await client.command({ query: RESOURCE_GUARDRAILS })
        logger.info('ClickHouse resource guardrails applied')
      } catch (guardrailErr) {
        logger.warn({ err: guardrailErr }, 'Failed to apply resource guardrails (non-fatal)')
      }

      logger.info('ClickHouse schema initialized successfully')
      return
    } catch (err) {
      lastError = err
      if (attempt < MAX_RETRIES) {
        const backoffMs = INITIAL_BACKOFF_MS * 2 ** (attempt - 1)
        logger.warn(
          { attempt, maxRetries: MAX_RETRIES, backoffMs, err },
          'Schema initialization failed, retrying',
        )
        await sleep(backoffMs)
      }
    }
  }

  throw lastError
}
