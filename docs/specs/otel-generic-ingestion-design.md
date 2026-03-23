# OpenTelemetry + Generic JSON Ingestion Design Spec

**Date:** 2026-03-23
**Status:** Approved
**Issue:** #103

## Goal

Open LogWeave to every language and framework by adding two new ingestion endpoints that accept logs from Go, Python, Java, and any OTel Collector — the #1 adoption blocker identified in SRE and PM reviews.

## Approach

Two new endpoints, one shared pipeline. Both feed into the existing `ingestBatch()` function. No schema or architecture changes needed — translation happens at the route/parser level only.

### Endpoint 1: Generic JSON — `POST /v1/ingest/logs`

Simple HTTP endpoint accepting structured JSON logs from any language.

- Accepts single event `{message, service, level, ...}` or array `[{...}, ...]`
- Auto-detects single vs array by checking if body is an array
- `service` optional with fallback to `''` (matches existing behavior)
- Extended message field search: `message`, `msg`, `log`, `body` (via GenericLogParser)
- Extended timestamp handling: ISO 8601 strings + numeric Unix epoch (seconds/ms)
- Timestamp field search: `timestamp`, `@timestamp`, `time`, `date`
- Max batch size: 1000 events (enforced after array normalization)
- Source type: `"http"`
- Same auth (Bearer token), ingest rate limit bucket

**Compatible with:** FluentBit output-http, Vector HTTP sink, curl, any language HTTP client.

### Endpoint 2: OTLP/HTTP JSON — `POST /v1/logs`

OpenTelemetry-compatible endpoint at the standard OTLP path.

- Accepts `ExportLogsServiceRequest` JSON format
- JSON only for MVP — returns 415 with actionable error for `application/x-protobuf`
- Gzip decompression middleware (OTel Collectors send gzip by default)
- Higher body limit: 5MB (vs 1MB global default)
- Protocol adapter: `otlpToEvents()` flattens `resourceLogs[] → scopeLogs[] → logRecords[]` into flat event objects
- Returns OTLP-spec response: `{ partialSuccess: { rejectedLogRecords, errorMessage } }`
- Max batch size: 1000 log records (after flattening)
- Source type: `"otlp"`

**OTLP attribute mapping:**
| OTLP Field | LogWeave Field |
|------------|---------------|
| `resource.attributes["service.name"]` | `service` |
| `resource.attributes["deployment.environment"]` | `environment` |
| `logRecord.severityText` / `severityNumber` | `level` |
| `logRecord.body.stringValue` | `message` |
| `logRecord.traceId` (hex) | `traceId` |
| `logRecord.attributes["http.status_code"]` | `statusCode` |
| `logRecord.attributes["http.route"]` | `route` |
| All other attributes | Dropped (by design — no raw log storage) |

**Empty body handling:** OTLP log records with empty `body.stringValue` are skipped (metadata-only records have no clustering value).

## Scope

**In scope:**
- `POST /v1/ingest/logs` — generic JSON endpoint (single + batch)
- `POST /v1/logs` — OTLP/HTTP JSON endpoint
- `GenericLogParser` — extended message/field extraction
- `otlpToEvents()` — OTLP flattening adapter
- Gzip decompression middleware (OTLP route only)
- Numeric timestamp support in `extractTimestamp`
- Rate limiter fix for non-`/ingest/` ingestion routes
- 415 content-type guard for protobuf
- Unit tests for both endpoints + parsers

**Out of scope / deferred:**
- OTLP protobuf encoding (requires new dependency, defer to follow-up)
- OTel traces/metrics endpoints (logs only)
- Custom LogParser for logfmt/plain text
- FluentBit-specific Kubernetes metadata extraction (k8s.namespace, etc.)
- OpsGenie/email notification channels
- SDK libraries for Go/Python/Java (users use HTTP directly or OTel Collector)

## Design

### Module Structure

```
services/api/src/
  pipeline/
    parse.ts              — existing JsonLogParser (unchanged)
    parse-generic.ts      — GenericLogParser (wider field name search)
    parse-otlp.ts         — otlpToEvents() adapter function
    ingest.ts             — existing (add numeric timestamp support to extractTimestamp)
  routes/
    ingest.ts             — existing Winston route (unchanged)
    ingest-generic.ts     — POST /v1/ingest/logs
    ingest-otlp.ts        — POST /v1/logs
  middleware/
    rate-limit.ts         — fix path detection for /logs route
```

### Rate Limiter Fix

Current check at `rate-limit.ts:61`: `req.path.startsWith('/ingest/')`.
Fix: check for any ingestion route: `req.path.startsWith('/ingest/') || req.path === '/logs'`.

### Gzip Decompression

Route-specific middleware on the OTLP endpoint only. Check `Content-Encoding: gzip` header, pipe through `zlib.createGunzip()`. Enforce body size limit AFTER decompression to prevent zip bombs.

### extractTimestamp Enhancement

Add to existing `extractTimestamp` function:
- Check `date` field in addition to `timestamp`, `@timestamp`, `time`
- Handle numeric values: detect seconds (< 1e12) vs milliseconds (>= 1e12), convert to ISO 8601

## Open Questions

None — architect review resolved all design decisions.

## Test Strategy

- GenericLogParser: message extraction from `message`/`msg`/`log`/`body` fields
- Generic endpoint: single event, array of events, missing service fallback, batch size limit
- OTLP adapter: flatten nested structure, attribute extraction, empty body skip, trace ID normalization
- OTLP endpoint: JSON content-type, 415 for protobuf, gzip decompression, OTLP response format
- extractTimestamp: ISO 8601, Unix seconds, Unix milliseconds, `date` field
- Rate limiter: `/logs` route gets ingest bucket
- Integration: end-to-end through pipeline (requires Docker)
