# Live Tail — Ephemeral Real-Time Log Stream

**Date:** 2026-03-21
**Status:** Approved (revised after SRE + Security/DPO persona reviews)
**Issue:** #43

## Goal

Enable real-time debugging by streaming log event metadata as events flow through
the ingest pipeline, with three tiers of visibility controlled per-tenant.

## Approach

In-memory per-tenant ring buffer in the ingest pipeline, with three consumers: MCP tool
(cursor-based polling), SSE API endpoint (long-lived streaming), and dashboard UI panel.

Three-tier visibility model:
- **Tier 1 (default):** template_text + structured metadata fields (zero PII risk)
- **Tier 2 (opt-in):** preprocessed messages included (`<IP>`, `<EMAIL>` placeholders — mostly safe but preprocessing has known gaps)
- **Tier 3 (future):** raw messages (requires consent + DPA + custom redaction patterns)

## Scope

**In scope:**
- Per-tenant ring buffer (configurable, default 60s / 10k events max)
- Buffer only populated for tenants with tail enabled (data minimization)
- Hook in ingest pipeline after Phase 3 (enrichment) to publish events to buffer
- `live_tail` MCP tool — cursor-based, returns recent events with service/level/template filter
- `GET /v1/tail` SSE endpoint — streams events to connected clients in real-time
- Dashboard live tail panel — scrolling log view with filters
- Three-tier visibility model with per-tenant setting
- Tenant isolation: buffer and connections are strictly per-tenant
- Connection limits: max N concurrent tail connections per tenant (default 5)
- Backpressure: drop oldest events when buffer full, drop slow SSE clients
- Audit log table for tail connections (SOC2)
- Per-tenant tail enable/disable toggle (default: disabled)
- Global memory ceiling for tail buffers

**Out of scope / deferred:**
- Tier 3 raw message streaming (requires consent toggle + DPA + custom redaction)
- Custom per-tenant redaction patterns for preprocessing gaps
- Cross-tenant tail (admin/support use case)
- Persistent replay beyond buffer window
- WebSocket (SSE is simpler and sufficient — unidirectional server→client)
- Historical tail (use existing dashboard queries for that)
- Tail across multiple API instances (single-instance MVP, shared buffer needs Redis/NATS later)
- API key permission scoping (tracked as separate issue — affects all endpoints, not just tail)

## Design

### 1. Three-Tier Visibility Model

Per-tenant setting in `tenant_settings`:
- `tail_mode: 'disabled' | 'metadata' | 'preprocessed'`
- Default: `'disabled'` — buffer not populated, tail endpoints return "tail not enabled"
- `'metadata'`: template_text + structured fields (service, level, status_code, etc.)
- `'preprocessed'`: includes `preProcessedMessage` field (PII-redacted but with known gaps)

Changing from `disabled` → `metadata` or `preprocessed` is logged in the audit trail
(who enabled it, when). Changing from `preprocessed` → `metadata` or `disabled` is also
logged. The audit record of mode changes is permanent.

### 2. Ring Buffer

```typescript
interface TailEvent {
  seq: number              // monotonic sequence number (per-tenant)
  timestamp: string
  service: string
  level: string
  templateId: string
  templateText: string
  preProcessedMessage?: string  // only populated in 'preprocessed' tier
  anomalyScore: number
  statusCode: number
  durationMs: number
  traceId: string
  route: string
}

interface TailBuffer {
  push(tenantId: string, event: TailEvent): void

  since(tenantId: string, afterSeq: number, options?: {
    service?: string
    level?: string
    templateId?: string
    minAnomalyScore?: number
    limit?: number
  }): { events: TailEvent[]; cursor: number }

  recent(tenantId: string, options?: {
    seconds?: number
    service?: string
    level?: string
    templateId?: string
    minAnomalyScore?: number
    limit?: number
  }): { events: TailEvent[]; cursor: number }

  /**
   * Subscribe to new events (for SSE). Returns unsubscribe function.
   * CRITICAL: callbacks MUST NOT perform I/O. They should append to a
   * per-connection queue. The SSE write loop drains the queue asynchronously.
   * This prevents blocking the ingest pipeline on slow SSE clients.
   */
  subscribe(tenantId: string, callback: (event: TailEvent) => void): () => void

  stats(): { tenants: number; totalEvents: number; memoryBytes: number }
}
```

Implementation: `Map<tenantId, { events: TailEvent[], head: number, seq: number }>`.
Circular array with configurable max size. Lazy tenant creation on first event (only
for tenants with tail enabled). Evict idle tenant buffers after 5 minutes of no events.

**Buffer-wrap reconnection:** When `Last-Event-ID` or `cursor` refers to a sequence
number that has been evicted, replay from the oldest available event and include
`gap: true, missedEstimate: N` in the first event so the client/LLM knows events
were missed.

Configuration via environment:
- `LOGWEAVE_TAIL_BUFFER_SIZE`: max events per tenant (default 10000)
- `LOGWEAVE_TAIL_BUFFER_SECONDS`: max age in seconds (default 60)
- `LOGWEAVE_TAIL_MAX_CONNECTIONS`: max SSE connections per tenant (default 5)
- `LOGWEAVE_TAIL_MAX_MEMORY_MB`: global memory ceiling for all buffers (default 256)

**Memory estimation:** Each buffered event consumes approximately 500–900 bytes of
V8 heap (11 fields + string allocations + object overhead). At the default buffer
size of 10,000 events, each tail-enabled tenant uses 5–9 MB. The 256 MB default
ceiling holds ~28–51 concurrent tenants. Self-hosted deployments (1–5 tenants) can
increase the ceiling. SaaS deployments with 50+ tenants should size accordingly or
accept LRU eviction of less-active tenants.

**Memory safety:** When total buffer memory approaches `MAX_MEMORY_MB`, evict the
least-recently-active tenant's buffer first. Log a warning including the evicted
tenant ID, buffer size, and reason.

### 3. Pipeline Hook

After Phase 3 (enrichment), before Phase 4 (write), publish each event to the buffer.
**Only for tenants with tail enabled** (checked via tenant settings cache):

```typescript
// In ingestBatch(), after building rows[]
const tailMode = tailSettings.getMode(tenantId)  // cached, not a DB call
if (tailMode !== 'disabled') {
  for (const row of rows) {
    tailBuffer.push(tenantId, {
      seq: 0,  // assigned by buffer
      timestamp: row.timestamp,
      service: row.service,
      level: row.level,
      templateId: row.template_id,
      templateText: row.template_text,
      preProcessedMessage: tailMode === 'preprocessed'
        ? (row.pre_processed_message ?? '')
        : undefined,
      anomalyScore: row.anomaly_score ?? 0,
      statusCode: row.status_code ?? 0,
      durationMs: row.duration_ms ?? 0,
      traceId: row.trace_id ?? '',
      route: row.route ?? '',
    })
  }
}
```

### 4. MCP Tool: live_tail

```
Tool: live_tail
Title: Live Event Stream
Description: Watch events as they flow through the system in real-time. Returns the most
  recent events from the live buffer. Use cursor from previous calls to get only new events.
  Filter by service, level, template_id, or anomaly score. Requires tail to be enabled
  for the tenant. Use this during incident investigation to watch what's happening right now.

Input:
  service: string (optional — filter to one service)
  level: string (optional — filter to level, e.g. 'ERROR')
  template_id: string (optional — filter to specific pattern)
  min_anomaly: number (optional — only events with anomaly_score >= this)
  seconds: number (optional, default 30, max 60 — how far back on first call)
  limit: number (optional, default 50, max 200)
  cursor: number (optional — sequence number from previous call)
```

First call (no cursor): returns events from the last N seconds.
Subsequent calls (with cursor): returns only events after the cursor.
Returns: events + new cursor + count.
If tail is disabled: returns message "Live tail is not enabled for this tenant."

### 5. SSE Endpoint: GET /v1/tail

```
GET /v1/tail?service=payments&level=ERROR&template_id=xxx&min_anomaly=0.5
Authorization: Bearer <api-key>
Accept: text/event-stream
```

Response: SSE stream. Each event includes `id:` field for reconnection.

```
id: 1234
data: {"seq":1234,"timestamp":"2026-03-21T14:30:01.000Z","service":"payments","level":"ERROR","templateText":"Connection to <IP> timed out","statusCode":503,"durationMs":1200,"anomalyScore":0.8,"traceId":"abc-123"}

id: 1235
data: {"seq":1235,"timestamp":"2026-03-21T14:30:02.000Z","service":"payments","level":"WARN","templateText":"Retry attempt <*>","statusCode":0,"durationMs":0,"anomalyScore":0,"traceId":"abc-123"}
```

Connection lifecycle:
- Auth validated on connection open (same Bearer token)
- Returns 403 if tail is disabled for the tenant
- Connection tracked against per-tenant limit (default 5)
- Connection limit exceeded: return 429 with message "Maximum tail connections reached"
- Heartbeat: `:keepalive\n\n` every 10 seconds (prevents proxy timeouts, allows
  for GC pause tolerance against 60s ALB idle timeout)
- Response header: `X-Accel-Buffering: no` (prevents nginx buffering)
- Client reconnection: `Last-Event-ID` header → server replays from buffer
- Backpressure: if client falls >1000 events behind, disconnect with error event
- Graceful shutdown: `event: shutdown\n\n` on server stop

Rate limiting: connections counted against a separate `tailConnections` limit.

**Proxy guidance:** nginx requires `proxy_buffering off;` for SSE. ALB idle timeout
is 60s, covered by the 10s heartbeat. Document these requirements in setup guide.

**Stats endpoint:** `GET /v1/tail/stats` (authenticated) returns buffer utilization:
`{ tenants, totalEvents, memoryBytes, connectionsActive }`. Include in `/readyz`
response as well for monitoring dashboards.

### 6. Dashboard UI: Live Tail Panel

New panel in the dashboard (toggleable, not always-on):
- "Start Tail" button opens SSE connection
- Scrolling log view (most recent at bottom, auto-scroll)
- Service, level, and template_id filter dropdowns
- Anomaly score threshold slider
- Pause/resume button (pauses UI rendering, not the connection)
- Event count + rate indicator (events/sec for current filter)
- Connection status indicator (connected/reconnecting/disconnected)
- Auto-disconnect after 10 minutes of inactivity (configurable)
- Color-coded by level (ERROR=red, WARN=yellow, INFO=green)
- Anomaly score badge on high-anomaly events

### 7. Audit Log

New ClickHouse table for SOC2 compliance:

```sql
CREATE TABLE IF NOT EXISTS logweave.audit_log (
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
TTL toDateTime(timestamp) + toIntervalDay(365) DELETE
```

Actions logged:
- `tail.connect` — SSE connection opened (with filters)
- `tail.disconnect` — SSE connection closed (with reason, duration, events_streamed)
- `tail.mode_change` — tail_mode setting changed (from → to)
- `tail.mcp_session` — MCP polling session (logged once per session, not per poll).
  A session starts on first poll (cursor=undefined) and ends when no poll is received
  for 120 seconds. The audit record includes total polls, duration, and events returned.
  This prevents audit log bloat from high-frequency polling.

### 8. Security & Compliance (revised after reviews)

**Data in the buffer:**
- Tier 1 (metadata): template_text + structured fields only. Zero PII — Drain3
  templates have all variable content replaced with `<*>`. Metadata fields
  (service, level, status_code) contain no PII.
- Tier 2 (preprocessed): includes `preProcessedMessage` where standard patterns
  are replaced (`<IP>`, `<EMAIL>`, `<UUID>`, etc.). Known gaps: phone numbers,
  names, short numeric IDs (<6 digits), SSNs, medical codes. These gaps are
  documented and the controller accepts the risk by enabling Tier 2.

**GDPR (revised — corrected from initial spec):**
- LogWeave acts as a data processor under Article 28. The live tail constitutes
  "processing" under Article 4(2) (structuring, transmission, making available).
- Legal basis: contractual necessity — the controller has engaged LogWeave to
  provide log intelligence services, which includes real-time streaming.
- The DPA must explicitly enumerate real-time streaming as a processing activity.
- Ephemeral buffering (max 60s) minimizes data exposure but does not remove
  the processing classification. Data minimization is achieved by:
  (a) only buffering for tenants with tail enabled (opt-in)
  (b) defaulting to Tier 1 (template + metadata, zero PII)
  (c) automatic eviction after configurable TTL
- Right to erasure: 60-second auto-eviction satisfies Article 17. No manual
  deletion mechanism needed — data ages out faster than any request could process.

**HIPAA:**
- Tier 1 (metadata only) is safe for covered entities — no PHI possible in
  template text or structured metadata fields.
- Tier 2 (preprocessed) has known gaps for healthcare-specific identifiers.
  HIPAA tenants should use Tier 1 only until custom redaction patterns are available.
- Per-tenant disable (tail_mode='disabled') is the default — HIPAA tenants
  remain disabled unless explicitly enabled with documented acceptance of risk.
- Future: custom per-tenant redaction patterns for phone numbers, SSNs, etc.

**SOC2:**
- All tail access logged to `logweave.audit_log` table (365-day retention)
- Fields logged: tenant, key_id, action, source_ip, filters, duration, events_streamed
- Audit records are append-only (MergeTree, no mutations)
- Connection limits prevent resource exhaustion

**Tenant isolation:**
- Buffer is keyed by tenant_id
- SSE connection validates tenant from auth token
- No cross-tenant access possible
- MCP tool uses same auth context

**Multi-instance limitation (documented):**
- Live tail buffer is per-process (in-memory). Behind a load balancer with N
  instances, a client sees only events ingested on the connected instance (~1/N).
- For single-instance deployments (self-hosted): no limitation.
- For multi-instance: use sticky sessions for SSE. Accept partial visibility.
  MCP tool polling may hit different instances (cursor is instance-local).

**Upgrade path: Redis Streams** (when multi-instance is needed):
- Add Redis container to Docker Compose
- Ingest pipeline publishes tail events to a Redis Stream per tenant
  (`XADD logweave:tail:{tenant_id}`) with MAXLEN cap for automatic trimming
- Each API instance subscribes via `XREAD BLOCK` and populates its local ring buffer
  from the shared stream — all instances see all events
- SSE reconnection uses Redis stream IDs instead of local sequence numbers
- MCP cursor maps to Redis stream ID — works across instances
- Redis Streams persist to disk, survive Redis restarts, and support consumer groups
- Migration: swap the ring buffer's `push()` source from direct ingest to Redis consumer.
  The TailBuffer interface and all consumers (SSE, MCP, dashboard) are unchanged.

## Open Questions

None — resolved during brainstorming and persona reviews.

## Test Strategy

- **Ring buffer unit tests:** push/evict, since/recent with cursors, service/level/template
  filtering, tenant isolation, idle eviction, memory ceiling enforcement,
  buffer-wrap gap detection (cursor points to evicted seq → replay from oldest + gap flag)
- **Pipeline hook test:** verify events only buffered for enabled tenants
- **MCP tool test:** cursor-based pagination, filter params, empty buffer, disabled tenant
- **SSE endpoint tests:** connection lifecycle, auth, 403 for disabled tenant, heartbeat,
  backpressure disconnect, Last-Event-ID replay, connection limit (429 on exceeded)
- **Audit log tests:** verify connection events written, mode change events written
- **Dashboard component tests:** connection state, auto-scroll, filter application, rate display
- **Integration test:** simulator → ingest → buffer → SSE → dashboard (requires Docker)

## Reviewer Findings Addressed

| Finding | Resolution |
|---------|-----------|
| GDPR "not storage" claim legally wrong | Reframed as data processor under Article 28 |
| Preprocessing misses phone/SSN/names/short IDs | Default to Tier 1 (template only, zero PII) |
| neverExtract doesn't redact message content | Documented; Tier 2 risk accepted by controller |
| Buffer populated for all tenants (data minimization) | Only populated for tenants with tail enabled |
| No per-tenant tail disable | Default disabled, opt-in per tenant |
| Ingest keys can access tail | Tracked as separate API key scoping issue |
| No audit trail | audit_log table with 365-day retention |
| Missing template_id filter | Added to MCP tool and SSE endpoint |
| Missing anomaly score filter | Added min_anomaly param |
| No global memory ceiling | LOGWEAVE_TAIL_MAX_MEMORY_MB config |
| Multi-instance gap | Documented with sticky sessions guidance |
| Deploy = buffer loss | Acknowledged; Last-Event-ID replay from buffer |
| SSE proxy concerns | X-Accel-Buffering header + proxy guidance |
| Connection limit exceeded behavior | 429 with clear message |
| Subscribe callbacks must be non-blocking | Documented in interface contract; queue, don't write |
| Buffer-wrap reconnection undefined | Replay from oldest + gap:true warning |
| Memory estimation absent | Documented: ~500-900 bytes/event, sizing guidance added |
| MCP poll audit logging too noisy | Session-based aggregation (one record per session) |
| Buffer stats not exposed | GET /v1/tail/stats endpoint + /readyz inclusion |
| Heartbeat too tight for GC pauses | Reduced to 10s (was 15s) |
| Idle tenant buffer cleanup | 5-minute idle eviction added |
