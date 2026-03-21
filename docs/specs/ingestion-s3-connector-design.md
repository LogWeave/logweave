# S3 Connector + Full Stack Dev Loop — Design Spec

**Date:** 2026-03-21
**Status:** Approved (revised after SRE + Platform Engineer persona reviews)
**Issues:** #42 (raw log drill-down), #53 (historical backfill — deferred)

## Goal

Enable end-to-end investigation of log patterns by connecting the intelligence layer
(metadata, MCP tools) to the raw logs stored in S3. Test the full product loop locally
with MinIO so we can prove the MCP tools work for real debugging before shipping.

**Key framing:** We are NOT a log viewer. We provide AI-driven investigation with small
raw log samples for context. The LLM already knows the pattern, service, and time window.
It just needs 10-50 raw lines to see actual values. For full log browsing, customers use
their existing tools (S3 console, CloudWatch Insights, etc.). We provide the needle, not
the haystack.

## Approach

Build a pluggable `LogSourceAdapter` interface with an S3 implementation that works
against both MinIO (local dev) and real AWS S3 (production). The simulator dual-writes
to both our API and MinIO, creating a realistic customer setup. The S3 connector reads
back raw logs on-demand for investigation via API endpoint and MCP tool.

## Scope

**In scope:**
- MinIO container in Docker Compose (S3-compatible local dev storage)
- Simulator dual-write: send events to API (existing) + write raw .jsonl to MinIO
- `source_ref` and `source_type` accepted in ingest payload (optional, additive)
- `LogSourceAdapter` interface — pluggable for future backends (Azure Blob, GCS, local FS)
- `S3Adapter` implementation using `@aws-sdk/client-s3` (works against MinIO and real S3)
- Connector config storage: `tenant_connectors` table in ClickHouse
- Connector CRUD API endpoints (create, list, test connection)
- `GET /v1/templates/:id/raw-logs` — fetch raw log lines matching a template
- `raw_logs` MCP tool — LLM-accessible raw log investigation
- Template-to-regex query translation (ADR-010: `<UUID>` → regex, `<IP>` → regex, etc.)
- Rate limiting on raw log fetches (10/min, 3 concurrent per tenant)
- Scan safety caps (20 files max, 30s timeout)
- S3 console links in responses for deeper investigation
- Graceful degradation when no connector is configured
- Full local dev loop: Docker up → simulator → ClickHouse → MCP tools → raw log drill-down

**Out of scope / deferred:**
- Model C passthrough (LogWeave writes to customer S3 during ingest) — future upsell
- IAM AssumeRole + STS credential caching — deferred to pre-customer
- Envelope encryption for stored credentials — deferred until real IAM roles needed
- CloudWatch adapter — post-MVP
- Azure Blob / GCS adapters — when first customer on those platforms
- Historical backfill from S3 (#53) — separate workload, separate ADR
- S3-compatible endpoints in production (MinIO, Wasabi) — SSRF concerns per ADR-010
- Hosted S3 storage-as-a-service pricing model
- Dashboard "View Raw Logs" panel — MCP tool first, dashboard later
- Audit log persistence for connector access (tracked for SOC2 prep)
- Connector-level access control within a tenant (tracked for multi-user)

## Design

### 1. LogSourceAdapter Interface

```typescript
interface LogSourceAdapter {
  readonly type: string  // 's3', 'azure-blob', 'gcs', 'local', etc.

  testConnection(config: ConnectorConfig): Promise<ConnectionTestResult>

  fetchRawLogs(params: {
    config: ConnectorConfig
    templateText: string      // with <UUID>, <IP>, <*> placeholders
    service: string           // narrows path resolution to one service
    timeRange: { start: Date; end: Date }
    limit: number             // max lines to return (default 50)
    sourceRef?: string        // direct S3 key if known (skips listing)
    cursor?: string           // pagination token
  }): Promise<RawLogResult>
}

interface RawLogResult {
  lines: Array<{
    timestamp?: string
    message: string
    source: string          // S3 key — used for console link
    sourceUrl?: string      // S3 console URL for direct access
  }>
  hasMore: boolean
  cursor?: string           // for next page
  filesScanned: number
  bytesScanned: number
  truncated: boolean        // true if scan cap was hit before limit
  truncatedReason?: string  // 'file_limit' | 'timeout' | 'byte_limit'
}

interface ConnectionTestResult {
  success: boolean
  message: string           // structured diagnostic
  filesFound?: number       // how many log files in last 24h
}
```

The interface is intentionally simple. Each adapter handles its own auth, path resolution,
and format parsing internally. The API layer just calls `fetchRawLogs()`.

**Key addition from review:** `service` parameter is required. Templates span multiple
services, and path patterns contain `{service}`. The caller must specify which service to
search (the LLM already knows this from `template_detail` or `error_patterns`).

### 2. S3Adapter Implementation

Uses `@aws-sdk/client-s3` which works against both MinIO (local) and AWS S3 (production).
The only difference is the `endpoint` config:
- MinIO: `http://minio:9002` (Docker) or `http://localhost:9002` (host)
- AWS: omitted (SDK uses default AWS endpoints)

**Read path (per ADR-010):**
1. If `sourceRef` is provided and non-empty, skip to step 3 with that key
2. Resolve S3 key prefix from `pathPattern` + `service` + time window
3. `ListObjectsV2` to find files in the resolved prefix (paginate if >1000)
4. For each file (max 20 files per request):
   a. `GetObject`, decompress if gzipped
   b. Stream lines through regex filter derived from `templateText`
   c. Accumulate matching lines until `limit` reached
   d. Stop early if limit reached or 30s wall time exceeded
5. Return matches + S3 console links + scan metadata

**Scan safety caps (from persona review):**
- Max 20 files scanned per request
- 30s wall-time timeout for the entire scan
- If caps are hit before enough matches found: return partial results with
  `truncated: true` and guidance to narrow the time window
- These are sensible defaults, not hard limits — can be tuned per deployment

**Template-to-regex translation:**
- `<UUID>` → `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
- `<IP>` → `\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`
- `<ID>` → `\d{6,}`
- `<EMAIL>` → `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+`
- `<TS>` → `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}`
- `<HEX>` → `[0-9a-f]{16,}`
- `<*>` → `.*?` (Drain3 wildcards beyond preprocessing)
- Literal segments escaped with `escapeRegExp()` and matched exactly

**Format support:**
- `jsonl`: parse JSON per line, extract `message` field, filter against regex
- `text`: filter raw lines against regex
- `cloudwatch_export`: parse nested JSON, extract `logEvents[].message` (deferred)

**Auth for MVP (local dev):**
- MinIO uses static access key/secret from env vars
- S3Adapter accepts optional `endpoint` + `forcePathStyle` for MinIO compatibility
- `accessKeyId` / `secretAccessKey` fields only valid when `endpoint` is set (MinIO mode)
- Production: IAM AssumeRole (same SDK, different credential provider, no stored secrets)

**S3 console links:**
For each matching line, include an S3 console URL:
`https://s3.console.aws.amazon.com/s3/object/{bucket}?prefix={key}`
For MinIO (local dev): `http://localhost:9001/browser/{bucket}/{key}`

### 3. Connector Config Storage

New `tenant_connectors` table in ClickHouse:

```sql
CREATE TABLE IF NOT EXISTS logweave.tenant_connectors (
    tenant_id       LowCardinality(String),
    connector_id    String,           -- UUIDv7
    name            String,           -- user-friendly label
    type            LowCardinality(String),  -- 's3', 'azure-blob', etc.
    config          String,           -- JSON blob
    created_at      DateTime64(3) DEFAULT now64(3),
    updated_at      DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, connector_id)
```

**Credential separation (from review):**
- When `endpoint` is set (MinIO/dev mode): `accessKeyId` and `secretAccessKey` allowed
  in config. These are MinIO dev credentials, not real AWS secrets.
- When `endpoint` is NOT set (production AWS): config contains only `roleArn`, `externalId`,
  `region`, `bucket`, `prefix`, `pathPattern`, `logFormat`, `compression`. No stored secrets.
  AssumeRole uses instance credentials or environment-based AWS auth.
- Validation enforced at the API layer: reject configs that have both `endpoint` and
  `roleArn`, or that have `secretAccessKey` without `endpoint`.

**Encryption deferred** — tracked for pre-customer hardening. Production configs contain
no secrets (roleArn is not secret), so this is lower priority than initially specced.

### 4. API Endpoints

**Connector management:**
- `POST /v1/connectors` — create connector (validates config shape per auth mode)
- `GET /v1/connectors` — list connectors for tenant (redacts sensitive fields)
- `POST /v1/connectors/:id/test` — test connection (ListObjects + sample GetObject)
- `DELETE /v1/connectors/:id` — remove connector

**Raw log retrieval:**
- `GET /v1/templates/:id/raw-logs?hours=1&limit=50&service=xxx&connector_id=xxx`
  - `hours`: time window (default 1, max 24)
  - `limit`: max lines (default 50, max 100)
  - `service`: required — which service's logs to search
  - `connector_id`: optional — uses tenant's default connector if omitted
- Rate limited: 10/min, 3 concurrent per tenant
- Response cap: 10MB
- Cursor pagination for additional pages

**Graceful degradation (from review):**
- If no connector configured: return 200 with empty `lines` and
  `message: "No log source connector configured. Set up an S3 connector to enable raw log drill-down."`
- If connector test fails: return structured error with diagnostic
  (e.g., "AssumeRole failed — check trust policy")

### 5. MCP Tool: raw_logs

```
Tool: raw_logs
Title: Raw Log Samples
Description: Fetch actual raw log lines that match a template pattern from the
  customer's S3 storage. Use this to see real log content when investigating an error.
  Requires a configured S3 connector. If no connector is configured, this tool will
  tell you. Use template_id from error_patterns or changes. Always specify the service.

Input:
  template_id: string (required)
  service: string (required — which service's logs to search)
  hours: number (optional, default 1, max 24)
  limit: number (optional, default 20, max 100)
```

Output: Markdown with:
- Raw log lines (message text)
- S3 source file for each line (with console link)
- Scan metadata (files scanned, truncation warning if applicable)
- Guidance if no connector configured

### 6. Docker Compose: MinIO

Add MinIO container (port 9002 to avoid conflict with ClickHouse native on 9000):
```yaml
minio:
  image: minio/minio
  command: server /data --console-address ":9001"
  ports:
    - "9002:9000"   # S3 API (9000 taken by ClickHouse native)
    - "9001:9001"   # MinIO Console
  environment:
    MINIO_ROOT_USER: minioadmin
    MINIO_ROOT_PASSWORD: minioadmin
  volumes:
    - minio-data:/data
```

Init script creates the default bucket (`logweave-logs`) on startup.

### 7. Simulator Dual-Write

Extend the simulator to optionally write raw events to MinIO alongside sending to API:
- New flag: `--s3-bucket` (enables S3 write)
- Writes .jsonl files partitioned by `{service}/{year}/{month}/{day}/{hour}/`
- Each file contains the raw JSON events (before preprocessing)
- Simulator sets `source_ref` to the S3 key it wrote and passes it in the ingest payload

### 8. source_ref + source_type in Ingest

Update the ingest pipeline to accept optional `source_ref` and `source_type` from callers:
- Ingest batch schema gains two optional fields: `source_ref` (string), `source_type` (string)
- If provided, stored in log_metadata as-is
- If not provided, defaults remain (`source_type: 'transport'`, `source_ref: ''`)
- When `source_ref` is populated, the S3 connector uses it for targeted GetObject
  (skips ListObjects entirely — fast path)
- FluentBit users can pass a prefix as `source_ref` (they don't know the exact key)
- Model C (future) will populate exact keys since we control the S3 write

**Why this is additive and safe:**
- Purely optional — no breaking changes to existing ingest callers
- Empty source_ref falls back to prefix-based scanning (current design)
- Non-empty source_ref enables faster, targeted fetches

## Reviewer Findings Addressed

| Finding | Resolution |
|---------|-----------|
| Scan budget / OOM risk | 20-file cap, 30s timeout, partial results with guidance |
| `{service}` unresolvable in pathPattern | `service` is required param on raw_logs endpoint |
| Data transfer cost | Moderate defaults (1h, 50 lines, 20 files). S3 links for deeper access. |
| ADR/spec credential contradiction | Credential separation: MinIO mode vs production mode, validated at API |
| No connector graceful degradation | Return 200 with empty lines + actionable setup message |
| Port 9000 conflict | MinIO on 9002, ClickHouse keeps 9000 |
| source_ref from external callers | Accepted in ingest payload, optional, additive |
| S3 console links | Included in every raw log response for escape-hatch investigation |
| Template-to-regex accuracy | Explicit test coverage for all placeholder types + Drain3 `<*>` |
| ListObjectsV2 pagination | Handle >1000 files per prefix with continuation tokens |
| Missing IAM permissions | Tracked for production: s3:GetBucketLocation, kms:Decrypt |
| Byte-range on unsorted files | Removed — replaced with file count cap + wall-time timeout |

## Open Questions

None — all resolved during brainstorming and persona reviews.

## Test Strategy

- **Template-to-regex unit tests:** verify all placeholder types translate correctly,
  including Drain3 `<*>` wildcards. Edge cases: templates with multiple wildcards,
  templates that are pure wildcards, empty templates.
- **S3Adapter unit tests:** mock S3 client, verify ListObjects/GetObject/regex flow,
  verify scan caps (file limit, timeout), verify cursor pagination,
  verify sourceRef fast path.
- **Connector CRUD route tests:** standard mocked DB tests (create, list, test, delete).
  Verify credential validation (reject mixed MinIO + IAM configs).
- **Raw log endpoint tests:** mocked adapter, verify response shape, rate limiting,
  service param required, graceful degradation when no connector.
- **MCP tool tests:** verify Markdown formatting, S3 links, truncation warnings,
  no-connector message.
- **Integration test:** MinIO + simulator + full read-back loop (requires Docker).
