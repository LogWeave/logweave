# LogWeave Clusterer

Log template extraction service powered by [Drain3](https://github.com/logpai/Drain3). Takes raw log messages, clusters them into template patterns, and assigns stable UUIDv7 template IDs via ClickHouse.

**Key property:** the clusterer never stores raw log content. It extracts structural patterns (templates) and discards the original messages. Raw logs stay in the customer's infrastructure.

## How Data Flows

Log messages arrive via `POST /cluster`, get clustered by Drain3 into template patterns, receive stable IDs from the template registry, and return as structured results. The checkpoint system persists Drain3 state across restarts.

```mermaid
graph LR
    A[API Server] -->|POST /cluster| B[Clusterer]
    B --> C{Drain3}
    C -->|template_text| D[Template Registry]
    D -->|cache hit| E[Response]
    D -->|cache miss| F[(ClickHouse)]
    F --> E
    B -->|background| G[Checkpoint Manager]
    G -->|atomic write| H[/Checkpoint Volume/]
```

### Request Flow

```mermaid
sequenceDiagram
    participant API as API Server
    participant MW as Middleware
    participant EP as /cluster endpoint
    participant SEM as Semaphore
    participant PIPE as ClusterPipeline
    participant DRAIN as DrainService
    participant REG as TemplateRegistry
    participant CH as ClickHouse

    API->>MW: POST /cluster
    MW->>MW: Extract/generate X-Request-ID
    MW->>EP: Forward request
    EP->>SEM: Acquire (100ms timeout → 503)
    SEM-->>EP: OK

    rect rgb(240, 248, 255)
        Note over EP,REG: asyncio.wait_for(timeout=0.45s)
        EP->>PIPE: cluster(tenant_id, messages)
        PIPE->>DRAIN: cluster_messages() [in thread]
        DRAIN-->>PIPE: DrainResult[]
        PIPE->>REG: batch_get_or_create(unique_texts)
        REG->>REG: Check LRU cache
        alt Cache misses exist
            REG->>CH: Batch SELECT ... FINAL
            CH-->>REG: Found templates
            REG->>CH: Batch INSERT (new only)
        end
        REG-->>PIPE: {text → (template_id, is_new)}
        PIPE-->>EP: ClusterResultItem[]
    end

    EP->>SEM: Release
    EP-->>MW: ClusterResponse
    MW->>MW: Log request_id, status, elapsed_ms
    MW-->>API: 200 OK
```

### Checkpoint Lifecycle

Drain3 state is serialized periodically and on shutdown. Checkpoints use atomic rename to prevent corruption, with optional HMAC-SHA256 integrity verification.

```mermaid
stateDiagram-v2
    [*] --> Running: Startup

    state Running {
        [*] --> RestoreCheckpoints: Load all .drain3 files
        RestoreCheckpoints --> Serving: Restore Drain3 state per tenant
        Serving --> CheckpointCycle: Every N seconds
        CheckpointCycle --> Serving: Save dirty tenants

        state CheckpointCycle {
            [*] --> GetDirtyTenants
            GetDirtyTenants --> SerializeState: For each dirty tenant
            SerializeState --> WriteTmp: tenant.drain3.tmp
            WriteTmp --> AtomicRename: os.replace → tenant.drain3
            AtomicRename --> MarkClean
            MarkClean --> [*]
        }
    }

    Running --> FlushCheckpoints: Shutdown signal
    FlushCheckpoints --> [*]: Save all dirty, cancel loop
```

```mermaid
graph TD
    subgraph "Checkpoint Save (atomic)"
        A[Serialize Drain3 state] --> B{HMAC key set?}
        B -->|Yes| C[Append HMAC-SHA256 tag]
        B -->|No| D[Raw state bytes]
        C --> E[Write to .drain3.tmp]
        D --> E
        E --> F[os.replace → .drain3]
        E -->|failure| G[Cleanup .tmp in finally]
    end

    subgraph "Checkpoint Load"
        H[Read .drain3 file] --> I{HMAC key set?}
        I -->|Yes| J[Verify HMAC tag]
        I -->|No| K[Return raw bytes]
        J -->|Valid| K
        J -->|Invalid| L[Reject, return None]
    end
```

## Architecture

| Component | Responsibility |
|---|---|
| **DrainService** | Per-tenant Drain3 instances, thread-safe clustering, dirty tracking |
| **TemplateRegistry** | UUIDv7 ID assignment, LRU cache, batch ClickHouse operations |
| **CheckpointManager** | Atomic persistence, HMAC verification, stale tmp cleanup |
| **ClusterPipeline** | Orchestrates drain → registry → checkpoint lifecycle |
| **main.py** | FastAPI app, lifespan, middleware, backpressure controls |

## Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness probe — always 200 |
| `/ready` | GET | Readiness probe — checks ClickHouse (5s cache) |
| `/cluster` | POST | Cluster messages, return template IDs |

## Configuration

All settings use the `LOGWEAVE_` env prefix. See `.env.example` for the full list.

Key settings:

| Variable | Default | Description |
|---|---|---|
| `LOGWEAVE_CLICKHOUSE_URL` | `clickhouse://localhost:9000/logweave` | ClickHouse DSN |
| `LOGWEAVE_DRAIN3_SIM_TH` | `0.4` | Drain3 similarity threshold |
| `LOGWEAVE_MAX_CONCURRENT_REQUESTS` | `4` | Semaphore limit for /cluster |
| `LOGWEAVE_REQUEST_TIMEOUT_SECONDS` | `0.45` | Per-request timeout |
| `LOGWEAVE_MAX_TENANTS` | `200` | Max concurrent tenants |
| `LOGWEAVE_CHECKPOINT_HMAC_KEY` | _(empty)_ | HMAC key for checkpoint integrity |

## Development

```bash
cd services/clusterer
uv sync --dev
uv run poe test      # 96 tests
uv run poe check     # lint + format check
uv run poe serve     # dev server with hot reload
```
