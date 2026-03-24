# Custom Metadata Tags Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Issue:** #142

## Goal

Let users search for specific events by business identifiers (customer_id, order_id, user_id) — enabling "did client 123 hit this pattern?" queries without storing raw log content.

## Approach

Separate `event_tags` table in ClickHouse with ORDER BY optimized for tag lookups. Tenant-configured allowlist of fields to extract. Max 10 keys, 256 char values.

## Scope

**In scope:**
- ClickHouse `event_tags` table
- `extractTags` field in TenantSettings (string array of field names)
- Ingest pipeline extracts configured fields and writes to event_tags
- API endpoint: GET /v1/events/by-tag?key=customer_id&value=ACME-123
- MCP tool: search_by_tag
- Settings UI: manage tag extraction allowlist
- 30-day TTL on event_tags

**Out of scope / deferred:**
- Value hashing for PII (v2)
- Tag value statistics / aggregations (v2)
- Per-service tag configuration
- Auto-discovery of available tag keys

## Design

### 1. Schema

```sql
CREATE TABLE IF NOT EXISTS logweave.event_tags (
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
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, tag_key, tag_value, timestamp)
TTL toDateTime(timestamp) + toIntervalDay(30) DELETE
SETTINGS ttl_only_drop_parts = 1
```

One row per tag per event. An event with 3 configured tags creates 3 rows.

### 2. TenantSettings

Add `extractTags` to TenantSettings:
```typescript
interface TenantSettings {
  // ... existing fields
  extractTags?: string[]  // e.g., ['customer_id', 'order_id', 'region']
}
```

Validation: max 10 items, each max 64 chars, alphanumeric + underscore only.

### 3. Ingest Pipeline Change

In `ingestBatch()`, after building `LogMetadataRow[]`:

```typescript
// Extract configured tags
const extractTags = deps.settingsStore?.get(tenantId).extractTags
if (extractTags && extractTags.length > 0) {
  const tagRows = []
  for (const item of items) {
    const event = events[i] as Record<string, unknown>
    for (const tagKey of extractTags) {
      const value = event[tagKey] ?? event.fields?.[tagKey]
      if (value !== undefined && typeof value === 'string' && value.length <= 256) {
        tagRows.push({
          tenant_id: tenantId,
          event_id: row.id,  // from the log_metadata row
          template_id: row.template_id,
          service: row.service,
          level: row.level,
          timestamp: row.timestamp,
          tag_key: tagKey,
          tag_value: String(value),
        })
      }
    }
  }
  if (tagRows.length > 0) {
    await db.insert({ table: 'logweave.event_tags', values: tagRows, format: 'JSONEachRow' })
  }
}
```

### 4. API Endpoint

```
GET /v1/events/by-tag?key=customer_id&value=ACME-123&hours=24&limit=50

Response:
{
  "data": [
    {
      "eventId": "019d...",
      "templateId": "019d...",
      "templateText": "Payment processed for order <*>",
      "service": "payments-api",
      "level": "INFO",
      "timestamp": "2026-03-24T10:30:00.000Z",
      "traceId": "abc789",
      "tags": { "customer_id": "ACME-123", "order_id": "ORD-456" }
    }
  ],
  "meta": { "count": 1, "hours": 24 }
}
```

The endpoint JOINs event_tags with log_metadata to return full event context including template text and trace ID. Also returns all other tags for matching events.

### 5. MCP Tool

```
search_by_tag:
  description: "Find events by a business identifier (customer_id, order_id, etc.)"
  input: { key: string, value: string, hours?: number }
  output: formatted list of matching events with templates, services, trace IDs
```

### 6. Settings UI

New section on Settings page: "Tag Extraction"

```
Extract custom fields from your logs for searchable metadata.
Only configured fields are stored — everything else is discarded.

  [customer_id]  [x]
  [order_id]     [x]
  [region]       [x]

  [+ Add field]

  Max 10 fields. Field names must be alphanumeric/underscore.
```

### 7. Query

```sql
SELECT
    et.event_id, et.tag_key, et.tag_value,
    et.template_id, et.service, et.level, et.timestamp,
    tr.template_text
FROM logweave.event_tags et
LEFT JOIN logweave.template_registry FINAL tr
    ON et.tenant_id = tr.tenant_id AND et.template_id = tr.template_id
WHERE et.tenant_id = {tenant_id:String}
  AND et.tag_key = {tag_key:String}
  AND et.tag_value = {tag_value:String}
  AND et.timestamp > now64(3) - toIntervalHour({hours:UInt32})
ORDER BY et.timestamp DESC
LIMIT {limit:UInt32}
```

## Test Strategy

- Schema migration creates event_tags table
- Ingest with extractTags configured writes tag rows
- Ingest without extractTags writes zero tag rows
- API endpoint returns matching events with template text
- Validation: max 10 keys, max 256 char values, rejects non-string values
- Tenant isolation: tenant A tags not visible to tenant B
