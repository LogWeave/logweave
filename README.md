# LogWeave

**The log intelligence layer your AI agent queries.** Add one line to your Winston config and your logs get pattern detection, anomaly alerts, and structured intelligence -- queryable via REST API or MCP server. Your AI assistant already knows your codebase; LogWeave tells it what's happening at runtime. Together, they diagnose production issues faster than any dashboard. LogWeave never stores raw log content -- it extracts patterns and discards the rest.

## Quick Start

### Docker (API only)

```bash
git clone https://github.com/RobertDicker/logweave.git
cd logweave
docker compose up --build
```

Three containers start: **API Server** (:3000), **Clusterer** (:8000), **ClickHouse** (:8123).

Send some logs and watch clustering in action:

```bash
curl -s -X POST http://localhost:3000/v1/ingest/batch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer e2e-key-tenant-a" \
  -d '{
    "service": "demo",
    "events": [
      {"message": "User 12345 logged in from 192.168.1.1", "level": "info"},
      {"message": "User 67890 logged in from 10.0.0.1", "level": "info"},
      {"message": "User 11111 logged in from 172.16.0.5", "level": "info"},
      {"message": "Payment failed for order abc-123", "level": "error"},
      {"message": "Payment failed for order def-456", "level": "error"},
      {"message": "Payment failed for order ghi-789", "level": "error"},
      {"message": "Connection pool exhausted after 30s", "level": "error"},
      {"message": "Connection pool exhausted after 45s", "level": "error"},
      {"message": "Health check passed", "level": "info"},
      {"message": "Health check passed", "level": "info"},
      {"message": "Retry attempt 3 for request req-001", "level": "warn"},
      {"message": "Retry attempt 2 for request req-002", "level": "warn"}
    ]
  }'
```

12 events become 5 templates. LogWeave stores the patterns, not the raw content.

### Full Demo (with Dashboard + Simulator)

```bash
git clone https://github.com/RobertDicker/logweave.git
cd logweave
docker compose up --build -d    # start API + Clusterer + ClickHouse
pnpm install                    # install workspace deps
pnpm dev                        # starts dashboard + simulator
```

Open **http://localhost:5173** to see the dashboard with live data from the simulator.

<!-- TODO: Add dashboard screenshot -->

## Connect Your AI

LogWeave exposes 21 MCP tools for AI assistants (Claude Code, Cursor, Windsurf, etc.). Add this to your `.mcp.json`:

```json
{
  "mcpServers": {
    "logweave": {
      "type": "stdio",
      "command": "node",
      "args": ["services/mcp/dist/index.js"],
      "env": {
        "LOGWEAVE_API_URL": "http://localhost:3000",
        "LOGWEAVE_API_KEY": "your-api-key"
      }
    }
  }
}
```

Then ask your AI: *"What errors are happening in the payments service?"* or *"What changed after the last deploy?"*

Tools include: `overview`, `error_patterns`, `changes`, `service_health`, `diagnose_service`, `search_templates`, `template_detail`, `template_trend`, `correlations`, `related_patterns`, `trace_details`, `live_tail`, `deploys`, `list_services`, `service_outlier`, `level_distribution`, `template_events`, `raw_logs`, `list_rules`, `create_rule`, `list_alerts`.

## Ingestion Endpoints

| Endpoint | Format | Use Case |
|----------|--------|----------|
| `POST /v1/ingest/batch` | LogWeave SDK format | `@logweave/transport` Winston transport |
| `POST /v1/ingest/logs` | Generic JSON array | Any language / HTTP client |
| `POST /v1/logs` | OTLP/HTTP JSON | OpenTelemetry Collector export |

All endpoints require `Authorization: Bearer <api-key>` and return `{ accepted, clustered, new_templates }`.

## How Data Works

LogWeave stores patterns and metadata, never raw log content. When your app sends `"User 12345 logged in from 192.168.1.1"`, LogWeave extracts the template `"User <*> logged in from <*>"` and stores that -- along with occurrence counts, timestamps, anomaly scores, and service metadata. Raw logs stay in your infrastructure (S3, CloudWatch, wherever they already live).

## Architecture

```
Your App --> @logweave/transport --> API Server (Node.js/Express) --> ClickHouse
                                        |
                                    Clusterer (Python/FastAPI/Drain3)
```

Three containers via Docker Compose:
- **API Server** (Node.js / Express / TypeScript) -- ingestion, queries, dashboard endpoints, alerting
- **Clusterer** (Python / FastAPI / Drain3) -- template extraction via log clustering
- **ClickHouse** -- metadata store (ReplacingMergeTree, single-node)

## Project Structure

```
services/api/           Node.js Express TypeScript API server
services/clusterer/     Python FastAPI Drain3 clustering service
services/dashboard/     React/Vite SPA dashboard (Tailwind, ECharts)
services/mcp/           MCP server for AI assistants (21 tools)
packages/transport/     @logweave/transport -- Winston logger SDK (npm, MIT)
simulator/              Realistic log generator for demos
docs/                   ADRs, specs, lessons learned
```

## Development

### API Server

```bash
cd services/api
pnpm install
pnpm dev          # tsx watch + pino-pretty
pnpm test         # all tests
pnpm lint         # Biome check
pnpm typecheck    # tsc --noEmit
```

### Clusterer

```bash
cd services/clusterer
uv sync --dev
uv run poe serve   # dev server with hot reload
uv run poe test    # pytest
uv run poe check   # ruff lint + format check
```

### All Services

```bash
./dev.sh test      # run all tests across all services
./dev.sh lint      # lint everything
./dev.sh dev       # start dev servers
```

ClickHouse must be running for integration tests: `docker compose up clickhouse -d`

## Key Design Decisions

- **No raw log storage** -- only metadata and extracted patterns are persisted
- **Two-language stack** -- Drain3 has no production Node.js equivalent; Python handles clustering, Node.js handles everything else
- **Docker Compose, not Kubernetes** -- operational simplicity for solo maintainer
- **UUIDv7 for all IDs** -- globally unique, timestamp-sortable, no coordination needed
- **Best-effort clustering** -- 500ms timeout with graceful degradation to `[unclustered]`

See [docs/adr/](docs/adr/) for detailed Architecture Decision Records.

## Links

- [Architecture Plan (PLAN.md)](PLAN.md)
- [Architecture Decision Records](docs/adr/)
- [API Server README](services/api/README.md)
- [Clusterer README](services/clusterer/README.md)
- [Transport SDK README](packages/transport/README.md)
