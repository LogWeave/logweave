# LogWeave API Server

Express/TypeScript server handling log ingestion, metadata storage, recovery, and dashboard queries. Receives log events via the transport SDK, coordinates with the clusterer for template extraction, and writes metadata to ClickHouse.

## Architecture

### System Context

```mermaid
graph TB
    subgraph Clients
        SDK["@logweave/transport<br/>(Winston)"]
        Dashboard["Dashboard SPA"]
    end

    subgraph API["API Server (this service)"]
        Auth["Auth Middleware<br/>timing-safe Bearer"]
        Pipeline["Ingestion Pipeline"]
        Recovery["Recovery Sweep"]
        Health["Health Probes"]
        Queries["Query Endpoints"]
    end

    subgraph External
        Clusterer["Clusterer Service<br/>(FastAPI / Drain3)"]
        CH[("ClickHouse")]
    end

    SDK -->|POST /v1/ingest/batch| Auth
    Auth --> Pipeline
    Dashboard -->|GET /v1/*| Queries
    Pipeline -->|POST /cluster| Clusterer
    Pipeline -->|INSERT| CH
    Recovery -->|POST /cluster| Clusterer
    Recovery -->|INSERT + DELETE| CH
    Queries -->|SELECT ... FINAL| CH
    Health -->|ping| CH
    Health -->|GET /health| Clusterer
```

### Ingestion Pipeline

Four-phase pipeline processes every batch:

```mermaid
flowchart TD
    A["POST /v1/ingest/batch<br/>{ service, events[] }"] --> B

    subgraph Phase1["Phase 1 — Parse + Preprocess"]
        B["Extract message, level, service,<br/>environment, trace_id, route, ..."]
        B --> C["Strip high-cardinality tokens<br/>UUIDs → &lt;UUID&gt;<br/>IPs → &lt;IP&gt;<br/>timestamps → &lt;TIMESTAMP&gt;"]
    end

    C --> D

    subgraph Phase2["Phase 2 — Cluster"]
        D["POST /cluster to clusterer<br/>(single HTTP call for entire batch)"]
        D --> E{"Success?"}
        E -->|Yes| F["template_id, template_text,<br/>is_new_template per event"]
        E -->|Timeout / Error| G["Fallback: template_id='0'<br/>[unclustered]"]
    end

    F --> H
    G --> H

    subgraph Phase3["Phase 3 — Enrich"]
        H["Combine parsed fields +<br/>cluster result into LogMetadataRow"]
    end

    H --> I

    subgraph Phase4["Phase 4 — Write"]
        I["Batch INSERT into<br/>logweave.log_metadata"]
    end

    I --> J["Response:<br/>{ accepted, clustered,<br/>unclustered, new_templates }"]
```

### Recovery System

Background sweep re-clusters events that failed clustering on first pass:

```mermaid
flowchart TD
    Start["Recovery Sweep<br/>(startup + periodic)"] --> Query

    Query["SELECT rows WHERE<br/>template_id = '0'<br/>(cursor-paginated)"] --> Group

    Group["Group by tenant_id"] --> Cluster

    Cluster["POST /cluster per tenant<br/>(preprocessed messages)"] --> Check

    Check{"Response time<br/>> 300ms?"}
    Check -->|Yes| Abort["Abort sweep<br/>(backpressure)"]
    Check -->|No| Filter

    Filter["Filter: skip still-unclustered"] --> Insert

    Insert["INSERT recovered rows<br/>(new UUIDv7 IDs)"] --> Delete

    Delete["DELETE old rows<br/>(INSERT-first for crash safety)"] --> More

    More{"More pages?"}
    More -->|Yes| Query
    More -->|No| Done["Done — log metrics"]
```

### Circuit Breaker (ClusterClient)

```mermaid
stateDiagram-v2
    [*] --> Closed

    Closed --> Open: 5 consecutive failures
    Open --> HalfOpen: every 10th call (probe)
    HalfOpen --> Closed: probe succeeds
    HalfOpen --> Open: probe fails
    Open --> Open: non-probe call → instant fallback

    note right of Open
        Returns fallback:
        template_id = '0'
        template_text = '[unclustered]'
    end note
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/healthz` | No | Liveness probe — always `{ status: 'ok' }` |
| `GET` | `/readyz` | No | Readiness — ClickHouse ping, clusterer health, circuit state, metrics |
| `POST` | `/v1/ingest/batch` | Bearer | Batch ingest — 1-1000 events per request |

### POST /v1/ingest/batch

**Request:**
```json
{
  "service": "payment-service",
  "environment": "production",
  "neverExtract": ["transaction_id"],
  "events": [
    { "message": "User 123 logged in", "level": "info" },
    { "message": "Payment failed for order abc", "level": "error", "route": "/pay" }
  ]
}
```

**Response (200):**
```json
{
  "accepted": 2,
  "clustered": 2,
  "unclustered": 0,
  "new_templates": 1
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOGWEAVE_PORT` | `3000` | HTTP server port |
| `LOGWEAVE_CLICKHOUSE_URL` | required | ClickHouse HTTP URL |
| `LOGWEAVE_CLUSTERER_URL` | required | Clusterer base URL |
| `LOGWEAVE_API_KEYS` | required | JSON `{"api-key": "tenant-id"}` |
| `LOGWEAVE_CLUSTERER_TIMEOUT_MS` | `500` | Cluster request timeout |
| `LOGWEAVE_LOG_LEVEL` | `info` | pino log level |
| `LOGWEAVE_SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful shutdown deadline |
| `LOGWEAVE_RECOVERY_INTERVAL_MS` | `60000` | Recovery sweep interval |
| `LOGWEAVE_RECOVERY_LOOKBACK_HOURS` | `24` | Recovery query window |

## ClickHouse Schema

### Tables

- **`log_metadata`** — MergeTree, partitioned by month, TTL 30 days. Primary store for all processed log metadata.
- **`template_stats`** — AggregatingMergeTree, 5-minute buckets per template (excludes unclustered).
- **`service_stats`** — AggregatingMergeTree, hourly buckets per service.

### Materialized Views

- **`template_stats_mv`** — auto-aggregates template occurrences (WHERE template_id != '0')
- **`service_stats_mv`** — auto-aggregates service-level metrics (all rows)

## Module Structure

```
src/
├── index.ts              Server startup, graceful shutdown
├── app.ts                Express factory, middleware wiring
├── config.ts             Zod schema for env vars
├── logger.ts             pino + AsyncLocalStorage context
├── metrics.ts            In-memory counters
├── errors.ts             AppError + factory functions
├── http-status.ts        Status code constants
├── types.ts              Shared TypeScript types
├── middleware/
│   ├── auth.ts           SHA-256 timing-safe Bearer auth
│   ├── validate.ts       Zod body validation
│   ├── request-id.ts     X-Request-ID + AsyncLocalStorage
│   └── error-handler.ts  Centralized error handling
├── routes/
│   ├── health.ts         /healthz, /readyz
│   └── ingest.ts         POST /v1/ingest/batch
├── pipeline/
│   ├── parse.ts          JSON log parser (field extraction)
│   ├── preprocess.ts     High-cardinality token stripping
│   ├── cluster-client.ts ClusterClient + circuit breaker
│   ├── ingest.ts         4-phase pipeline orchestrator
│   └── types.ts          Pipeline type chain
├── db/
│   ├── client.ts         DbClient wrapper
│   ├── schema.ts         DDL + init
│   ├── insert.ts         Batch INSERT
│   ├── queries.ts        Parameterized SELECT queries
│   └── index.ts          Barrel export
├── recovery/
│   └── reconcile.ts      Recovery sweep (cursor-paginated)
└── clients/
    ├── clickhouse.ts     ClickHouse client factory
    └── clusterer.ts      Clusterer health checker
```

## Development

```bash
pnpm install
pnpm dev            # tsx watch + pino-pretty
pnpm test           # all tests
pnpm test:unit      # unit tests only
pnpm test:integration  # requires ClickHouse
pnpm lint           # Biome check
pnpm typecheck      # tsc --noEmit
```

Integration tests require ClickHouse:

```bash
docker compose up clickhouse -d
```

## Test Structure

```
tests/
├── unit/                     Isolated, no external deps
│   ├── auth.test.ts
│   ├── config.test.ts
│   ├── health.test.ts
│   ├── ingest.test.ts
│   ├── error-handler.test.ts
│   ├── request-id.test.ts
│   ├── security-headers.test.ts
│   └── pipeline/
│       ├── parse.test.ts
│       ├── preprocess.test.ts
│       ├── cluster-client.test.ts
│       └── timestamp.test.ts
├── integration/              Requires ClickHouse
│   ├── db/                   Schema, insert, queries, MVs
│   ├── pipeline/             Full cluster flow
│   └── recovery/             Recovery sweep
└── e2e/                      Full stack (docker compose)
```
