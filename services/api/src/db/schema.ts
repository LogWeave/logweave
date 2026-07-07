import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '@clickhouse/client'
import type pino from 'pino'

// Ledger of applied migrations. Each MIGRATIONS entry runs at most once per
// database (see initSchema), so the DROP VIEW + recreate steps no longer replay
// on every boot. ReplacingMergeTree keyed on migration_id makes re-recording a
// no-op even if two boots race.
const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS logweave.schema_migrations (
  migration_id String,
  applied_at   DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(applied_at)
ORDER BY migration_id`

/**
 * Stable content-addressed id for a migration statement. Keyed on the SQL text
 * so order changes don't reshuffle ids; editing a statement's text intentionally
 * re-runs it (treated as a new migration).
 */
export function migrationId(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16)
}

const DDL_STATEMENTS = [
  // 1. Create database (idempotent)
  `CREATE DATABASE IF NOT EXISTS logweave`,

  // 2. Primary fact table
  `CREATE TABLE IF NOT EXISTS logweave.log_metadata (
    id                     UUID DEFAULT generateUUIDv7(),
    event_id               UUID DEFAULT generateUUIDv7(),
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
  )
  -- ReplacingMergeTree dedups rows with an identical ORDER BY key, keeping the
  -- one with the largest version (ingest_time) — so an at-least-once replay
  -- collapses to a single row. Once event_id is source-stable (#268), a later
  -- re-enrichment that re-inserts the same event (async Drain3, #277) will
  -- likewise supersede the earlier write via its newer ingest_time. The dedup
  -- key is event_id (UUIDv7 assigned at the source, #268), so event_id is the
  -- trailing ORDER BY column: distinct events never collapse, a replayed event
  -- always does. Until #268, event_id defaults to a fresh per-insert UUID, so
  -- no rows share a key and reads behave exactly like the old MergeTree. Dedup
  -- is eventual (on merge); reads needing read-after-write must use FINAL.
  ENGINE = ReplacingMergeTree(ingest_time)
  -- Daily partitions so ttl_only_drop_parts=1 enforces the 30-day TTL tightly.
  -- Monthly (toYYYYMM) parts span ~31 days, so a part only drops ~30 days after
  -- its NEWEST row — retaining data up to ~59 days, ~2x the stated window.
  PARTITION BY toYYYYMMDD(timestamp)
  ORDER BY (tenant_id, service, timestamp, level, event_id)
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
  PARTITION BY toYYYYMMDD(interval_start)
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
  PARTITION BY toYYYYMMDD(interval_start)
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

  // 9. Archive reconciliation cursor (epic #265, #279) — per-tenant watermark.
  // Every archived object lexically <= last_key is confirmed present in
  // log_metadata; the reconciliation sweep lists from here forward and backfills
  // anything the best-effort notify hop missed. ReplacingMergeTree keeps the
  // highest-version row per tenant.
  `CREATE TABLE IF NOT EXISTS logweave.archive_reconcile_cursor (
    tenant_id   LowCardinality(String),
    last_key    String DEFAULT '',
    version     UInt64,
    updated_at  DateTime DEFAULT now()
  ) ENGINE = ReplacingMergeTree(version)
  ORDER BY (tenant_id)`,
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

  // Deploy markers table — records when services are deployed
  `CREATE TABLE IF NOT EXISTS logweave.deploys (
    deploy_id       String,
    tenant_id       LowCardinality(String),
    service         LowCardinality(String),
    version         Nullable(String),
    commit_sha      Nullable(String),
    timestamp       DateTime64(3) DEFAULT now64(3)
  ) ENGINE = MergeTree()
  -- Daily partitions are required for ttl_only_drop_parts=1 to enforce the TTL:
  -- with no PARTITION BY the whole table is one part-group that only drops once
  -- every row is past 90 days.
  PARTITION BY toYYYYMMDD(timestamp)
  ORDER BY (tenant_id, service, timestamp)
  TTL toDateTime(timestamp) + toIntervalDay(90) DELETE
  SETTINGS ttl_only_drop_parts = 1`,

  // 10. Connector config — stores log source connection settings per tenant
  `CREATE TABLE IF NOT EXISTS logweave.tenant_connectors (
    tenant_id       LowCardinality(String),
    connector_id    String,
    name            String,
    type            LowCardinality(String),
    config          String,
    created_at      DateTime64(3) DEFAULT now64(3),
    version         UInt64,
    is_deleted      UInt8 DEFAULT 0
  ) ENGINE = ReplacingMergeTree(version, is_deleted)
  ORDER BY (tenant_id, connector_id)`,

  // Embedding columns on template_registry for semantic search (co-owned with clusterer)
  `ALTER TABLE logweave.template_registry ADD COLUMN IF NOT EXISTS embedding Array(Float32) DEFAULT []`,
  `ALTER TABLE logweave.template_registry ADD COLUMN IF NOT EXISTS embedding_model LowCardinality(String) DEFAULT ''`,

  // 11. Service stats 5-minute buckets — sub-hour granularity for threshold alerting
  `CREATE TABLE IF NOT EXISTS logweave.service_stats_5m (
    tenant_id       LowCardinality(String),
    service         LowCardinality(String),
    level           LowCardinality(String),
    interval_start  DateTime64(3),
    log_count       AggregateFunction(count),
    error_count     AggregateFunction(countIf, UInt8),
    warn_count      AggregateFunction(countIf, UInt8)
  ) ENGINE = AggregatingMergeTree()
  -- Daily partitions: a 7-day TTL on monthly parts kept data up to ~37 days (5x).
  PARTITION BY toYYYYMMDD(interval_start)
  ORDER BY (tenant_id, service, interval_start)
  TTL toDateTime(interval_start) + toIntervalDay(7) DELETE
  SETTINGS ttl_only_drop_parts = 1`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS logweave.service_stats_5m_mv
  TO logweave.service_stats_5m AS
  SELECT
      tenant_id, service, level,
      toStartOfFiveMinutes(timestamp) AS interval_start,
      countState()                    AS log_count,
      countIfState(level = 'ERROR')   AS error_count,
      countIfState(level = 'WARN')    AS warn_count
  FROM logweave.log_metadata
  GROUP BY tenant_id, service, level, interval_start`,

  // Environment dimension in service_stats_5m (must come after CREATE TABLE above)
  `DROP VIEW IF EXISTS logweave.service_stats_5m_mv`,
  `ALTER TABLE logweave.service_stats_5m ADD COLUMN IF NOT EXISTS environment LowCardinality(String) DEFAULT ''`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS logweave.service_stats_5m_mv
TO logweave.service_stats_5m AS
SELECT
    tenant_id, service, environment, level,
    toStartOfFiveMinutes(timestamp) AS interval_start,
    countState()                    AS log_count,
    countIfState(level = 'ERROR')   AS error_count,
    countIfState(level = 'WARN')    AS warn_count
FROM logweave.log_metadata
GROUP BY tenant_id, service, environment, level, interval_start`,

  // 12. Alert rules — unified template watches + threshold rules
  `CREATE TABLE IF NOT EXISTS logweave.alert_rules (
    tenant_id      LowCardinality(String),
    rule_id        String,
    name           String,
    rule_type      LowCardinality(String),
    enabled        UInt8 DEFAULT 1,
    config         String,
    channels       String DEFAULT '[]',
    version        UInt64,
    is_deleted     UInt8 DEFAULT 0
  ) ENGINE = ReplacingMergeTree(version, is_deleted)
  ORDER BY (tenant_id, rule_id)`,

  // 13. Alert history — append-only log of fired alerts (90-day retention)
  `CREATE TABLE IF NOT EXISTS logweave.alert_history (
    alert_id            String,
    tenant_id           LowCardinality(String),
    rule_id             String,
    rule_type           LowCardinality(String),
    rule_name           String,
    fired_at            DateTime64(3) DEFAULT now64(3),
    metric_value        Float64,
    threshold_value     Float64,
    details             String DEFAULT '',
    channels_notified   String DEFAULT '[]'
  ) ENGINE = MergeTree()
  PARTITION BY toYYYYMMDD(fired_at)
  ORDER BY (tenant_id, fired_at)
  TTL toDateTime(fired_at) + toIntervalDay(90) DELETE
  SETTINGS ttl_only_drop_parts = 1`,

  // 14. Audit log — append-only, SOC2 compliance (365-day retention)
  `CREATE TABLE IF NOT EXISTS logweave.audit_log (
    timestamp          DateTime64(3) DEFAULT now64(3),
    tenant_id          LowCardinality(String),
    key_id             String,
    action             LowCardinality(String),
    source_ip          String DEFAULT '',
    details            String DEFAULT '',
    duration_ms        UInt64 DEFAULT 0,
    events_streamed    UInt64 DEFAULT 0
  ) ENGINE = MergeTree()
  ORDER BY (tenant_id, timestamp)
  TTL toDateTime(timestamp) + toIntervalDay(365) DELETE`,

  // 15. Template daily summary — 365-day trend analysis (daily granularity)
  `CREATE TABLE IF NOT EXISTS logweave.template_daily_summary (
    tenant_id          LowCardinality(String),
    service            LowCardinality(String),
    template_id        String,
    day                Date,
    occurrence_count   AggregateFunction(count),
    error_count        AggregateFunction(countIf, UInt8),
    avg_duration_ms    AggregateFunction(avg, Float64),
    max_anomaly_score  AggregateFunction(max, Float32)
  ) ENGINE = AggregatingMergeTree()
  PARTITION BY toYYYYMM(day)
  ORDER BY (tenant_id, service, template_id, day)
  TTL day + toIntervalDay(365) DELETE
  SETTINGS ttl_only_drop_parts = 1`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS logweave.template_daily_summary_mv
  TO logweave.template_daily_summary AS
  SELECT
      tenant_id, service, template_id,
      toDate(timestamp) AS day,
      countState()                      AS occurrence_count,
      countIfState(level = 'ERROR')     AS error_count,
      avgState(duration_ms)             AS avg_duration_ms,
      maxState(anomaly_score)           AS max_anomaly_score
  FROM logweave.log_metadata
  WHERE template_id != '0'
  GROUP BY tenant_id, service, template_id, day`,

  // 19. Event tags — searchable custom metadata fields (allowlist-only)
  `CREATE TABLE IF NOT EXISTS logweave.event_tags (
    tenant_id       LowCardinality(String),
    event_id        String,
    template_id     String,
    service         LowCardinality(String),
    level           LowCardinality(String),
    timestamp       DateTime64(3),
    tag_key         LowCardinality(String),
    tag_value       String,
    INDEX idx_tag_value tag_value TYPE bloom_filter(0.01) GRANULARITY 1
  ) ENGINE = MergeTree()
  PARTITION BY toYYYYMMDD(timestamp)
  ORDER BY (tenant_id, tag_key, tag_value, timestamp)
  TTL toDateTime(timestamp) + toIntervalDay(30) DELETE
  SETTINGS ttl_only_drop_parts = 1`,

  // 20. Dashboard users — authentication for the web UI
  `CREATE TABLE IF NOT EXISTS logweave.dashboard_users (
    user_id              String,
    username             LowCardinality(String),
    password_hash        String,
    tenant_id            LowCardinality(String),
    role                 LowCardinality(String) DEFAULT 'viewer',
    must_change_password UInt8 DEFAULT 0,
    totp_secret          String DEFAULT '',
    totp_enabled         UInt8 DEFAULT 0,
    recovery_codes       String DEFAULT '',
    session_version      UInt64 DEFAULT 1,
    last_login_at        Nullable(DateTime64(3)),
    version              UInt64,
    is_deleted           UInt8 DEFAULT 0
  ) ENGINE = ReplacingMergeTree(version, is_deleted)
  ORDER BY (tenant_id, username)`,

  // ---------------------------------------------------------------------------
  // ALTER migrations — MUST come after all CREATE TABLE statements above
  // ---------------------------------------------------------------------------

  // Cooldown minutes on alert_rules (depends on alert_rules table)
  `ALTER TABLE logweave.alert_rules ADD COLUMN IF NOT EXISTS cooldown_minutes UInt32 DEFAULT 0`,

  // 21. Internal operator event feed — structured events about LogWeave's own
  // health (config, downstream failures, auth anomalies). 7-day TTL. Separate
  // from customer log_metadata; never goes through Drain3. See #202.
  `CREATE TABLE IF NOT EXISTS logweave.internal_events (
    ts          DateTime64(3),
    service     LowCardinality(String),
    event       LowCardinality(String),
    severity    LowCardinality(String),
    code        LowCardinality(String),
    summary     String,
    fields      String DEFAULT '{}'
  ) ENGINE = MergeTree()
  PARTITION BY toYYYYMMDD(ts)
  ORDER BY (service, event, ts)
  TTL toDateTime(ts) + toIntervalDay(7) DELETE
  SETTINGS ttl_only_drop_parts = 1`,

  // 22. API keys — per-tenant service tokens, runtime-managed (no restart to
  // rotate). The raw key is never stored; only an HMAC-SHA256 digest is. Same
  // ReplacingMergeTree(version, is_deleted) pattern as `watches` so a revoke
  // is just an INSERT with is_deleted=1; readers use FINAL to see the
  // current state and filter on is_deleted.
  //
  // ORDER BY is `(tenant_id, key_id)` because:
  //   - every CRUD read path is tenant-scoped + key_id-scoped (list, revoke)
  //   - the auth hot path NEVER queries this table at request time. It uses
  //     the ApiKeyStore in-memory cache (hash → record), refreshed every 60s.
  // We deliberately don't index by `key_hash` — a DB-backed validation
  // fallback would be a real-AWS-style latency hit and a separate design
  // decision when/if scaling beyond single-instance demands it.
  `CREATE TABLE IF NOT EXISTS logweave.api_keys (
    tenant_id    LowCardinality(String),
    key_id       String,
    key_hash     String,
    key_prefix   String,
    name         String,
    created_at   DateTime64(3),
    created_by   String DEFAULT '',
    revoked_at   Nullable(DateTime64(3)),
    revoked_by   String DEFAULT '',
    version      UInt64,
    is_deleted   UInt8 DEFAULT 0
  ) ENGINE = ReplacingMergeTree(version, is_deleted)
  ORDER BY (tenant_id, key_id)`,
]

const RESOURCE_GUARDRAILS = `ALTER USER default SETTINGS
    max_execution_time = 30,
    max_memory_usage = 1073741824,
    max_rows_to_read = 10000000`

const MAX_RETRIES = 5
const INITIAL_BACKOFF_MS = 200

import { sleep } from '../lib/sleep.js'

/**
 * `log_metadata` must be `ReplacingMergeTree` (since #267), and ClickHouse has no
 * ALTER ... MODIFY ENGINE. An earlier version silently `DROP`ped a legacy
 * `MergeTree` table here to let the DDL recreate it — safe only while there was
 * no live data. At launch that assumption is false, so instead of dropping we
 * refuse to start and point the operator at a manual, data-preserving migration.
 * No-op on a fresh install (no table yet) or when the engine is already correct.
 */
export async function assertLogMetadataEngine(
  client: ClickHouseClient,
  _logger: pino.Logger,
): Promise<void> {
  const probe = await client.query({
    query: `SELECT engine FROM system.tables WHERE database = 'logweave' AND name = 'log_metadata'`,
    format: 'JSONEachRow',
  })
  const rows = (await probe.json()) as Array<{ engine: string }>
  const engine = rows[0]?.engine
  if (engine && engine !== 'ReplacingMergeTree') {
    throw new Error(
      `Refusing to start: logweave.log_metadata uses the legacy '${engine}' engine but must be ` +
        'ReplacingMergeTree (since #267). ClickHouse cannot ALTER the engine in place, so migrate ' +
        'manually to avoid data loss:\n' +
        '  1. RENAME TABLE logweave.log_metadata TO logweave.log_metadata_legacy;\n' +
        '  2. Restart LogWeave — the schema init recreates log_metadata as ReplacingMergeTree;\n' +
        '  3. INSERT INTO logweave.log_metadata SELECT * FROM logweave.log_metadata_legacy;\n' +
        '  4. DROP TABLE logweave.log_metadata_legacy;\n' +
        '(A pre-release install with only simulator data can instead DROP TABLE ' +
        'logweave.log_metadata and restart.)',
    )
  }
}

export async function initSchema(client: ClickHouseClient, logger: pino.Logger): Promise<void> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await assertLogMetadataEngine(client, logger)

      for (const ddl of DDL_STATEMENTS) {
        await client.command({ query: ddl })
      }

      // Run each migration at most once, gated on the schema_migrations ledger.
      // Replaying the whole array every boot re-ran the DROP VIEW + recreate
      // steps for 3 MVs, so every row ingested during that window was lost from
      // the *_stats aggregates. The ledger makes each statement run exactly once.
      await client.command({ query: SCHEMA_MIGRATIONS_DDL })
      const appliedProbe = await client.query({
        query: `SELECT migration_id FROM logweave.schema_migrations`,
        format: 'JSONEachRow',
      })
      const applied = new Set(
        ((await appliedProbe.json()) as Array<{ migration_id: string }>).map((r) => r.migration_id),
      )
      for (const migration of MIGRATIONS) {
        const id = migrationId(migration)
        if (applied.has(id)) continue
        await client.command({ query: migration })
        await client.insert({
          table: 'logweave.schema_migrations',
          values: [{ migration_id: id }],
          format: 'JSONEachRow',
        })
        applied.add(id)
      }

      // Resource guardrails — best-effort. Skip ALTER USER entirely when the
      // `default` user lives in a read-only directory (the typical Docker
      // setup with users.xml). Probing system.user_directories first avoids a
      // noisy ClickHouseError stack trace in logs/tests on every boot.
      try {
        const probe = await client.query({
          query: `SELECT count() AS n FROM system.users WHERE name = 'default' AND storage = 'local_directory'`,
          format: 'JSONEachRow',
        })
        const rows = (await probe.json()) as Array<{ n: number | string }>
        const sqlManaged = Number(rows[0]?.n ?? 0) > 0
        if (sqlManaged) {
          await client.command({ query: RESOURCE_GUARDRAILS })
          logger.info('ClickHouse resource guardrails applied')
        } else {
          logger.info(
            'Skipping ClickHouse resource guardrails — default user is in a read-only directory (e.g. users.xml). Rate limiting still protects at the API layer.',
          )
        }
      } catch (guardrailErr) {
        logger.warn(
          { err: guardrailErr },
          'Could not apply resource guardrails (non-fatal). Rate limiting still protects at the API layer.',
        )
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
