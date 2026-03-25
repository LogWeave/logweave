# LogWeave — Self-Hosted Install Guide

Get LogWeave running on your own infrastructure in 5 minutes.

## Prerequisites

- Docker Engine 24+ and Docker Compose v2
- 2 GB RAM minimum (4 GB recommended)
- 10 GB disk for ClickHouse data
- A machine with ports 3000 (API + dashboard) accessible

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/RobertDicker/logweave.git
cd logweave
```

### 2. Configure environment

```bash
cp .env.production.example .env
```

Edit `.env` and set the **required** values:

```bash
# Generate a secure API key
API_KEY=$(openssl rand -hex 32)
echo "Your API key: $API_KEY"

# Generate encryption key for connector secrets
ENC_KEY=$(openssl rand -hex 16)
```

Update these lines in `.env`:
```
LOGWEAVE_API_KEYS={"<your-api-key>":"<your-org-name>"}
LOGWEAVE_ENCRYPTION_KEY=<your-encryption-key>
```

**Save your API key** — you'll need it to send logs and access the dashboard.

### 3. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

This starts three containers:
- **ClickHouse** — metadata store (internal, not exposed)
- **Clusterer** — log pattern extraction (internal, not exposed)
- **API** — HTTP API + dashboard on port 3000

### 4. Verify

```bash
# Health check
curl http://localhost:3000/healthz
# Expected: {"status":"ok"}

# Or use the included script
chmod +x scripts/healthcheck.sh
./scripts/healthcheck.sh
```

### 5. Open the dashboard

Navigate to `http://localhost:3000` in your browser. The onboarding checklist will guide you through:

1. **Send your first logs** — copy-paste a curl command or SDK snippet
2. **Connect your AI assistant** — paste the MCP config into Claude Code / Cursor
3. **Tune clustering** — choose how specific your patterns should be

## Sending Logs

### HTTP API (any language)

```bash
curl -X POST http://localhost:3000/v1/ingest/batch \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "message": "User login succeeded for alice",
      "level": "INFO",
      "service": "auth-service"
    }]
  }'
```

### Node.js SDK

```bash
npm install @logweave/transport
```

```javascript
import { LogWeaveTransport } from "@logweave/transport";
import winston from "winston";

const logger = winston.createLogger({
  transports: [
    new LogWeaveTransport({
      endpoint: "http://localhost:3000",
      apiKey: "YOUR_API_KEY",
      service: "my-service",
    }),
  ],
});
```

### OpenTelemetry Collector

```yaml
exporters:
  otlphttp:
    endpoint: http://localhost:3000/v1/logs
    headers:
      authorization: "Bearer YOUR_API_KEY"

service:
  pipelines:
    logs:
      exporters: [otlphttp]
```

## Connecting AI (MCP)

Add to your editor's MCP config (Claude Code, Cursor, Windsurf):

```json
{
  "mcpServers": {
    "logweave": {
      "command": "npx",
      "args": ["@logweave/mcp"],
      "env": {
        "LOGWEAVE_API_URL": "http://localhost:3000",
        "LOGWEAVE_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

Then ask your AI: *"What error patterns are happening in my services?"*

## Production Hardening

### HTTPS with Caddy (recommended)

The simplest way to add TLS. Create a `Caddyfile`:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
# Install Caddy (Debian/Ubuntu)
sudo apt install -y caddy

# Start — automatically obtains Let's Encrypt certificate
sudo systemctl start caddy
```

Then update your MCP config and SDK endpoints to use `https://your-domain.com`.

### Backups

ClickHouse data is stored in the `clickhouse_data` Docker volume. Back up with:

```bash
# Stop the stack first for consistency
docker compose -f docker-compose.prod.yml stop

# Create backup
docker run --rm -v logweave_clickhouse_data:/data -v $(pwd):/backup \
  alpine tar czf /backup/clickhouse-backup-$(date +%Y%m%d).tar.gz /data

# Restart
docker compose -f docker-compose.prod.yml up -d
```

### Resource Limits

The production compose file sets memory limits:
- ClickHouse: 2 GB
- API: 512 MB
- Clusterer: 512 MB

Adjust in `docker-compose.prod.yml` under `deploy.resources.limits` if needed.

### Logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Single service
docker compose -f docker-compose.prod.yml logs -f api
```

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

ClickHouse data persists across updates. Schema migrations run automatically on startup.

## Environment Variable Reference

### API Server (`LOGWEAVE_*`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOGWEAVE_API_KEYS` | Yes | — | JSON mapping API keys to tenant IDs |
| `LOGWEAVE_ENCRYPTION_KEY` | Recommended | — | 16+ char key for encrypting connector secrets |
| `LOGWEAVE_PORT` | No | `3000` | API server port |
| `LOGWEAVE_LOG_LEVEL` | No | `info` | Log level (fatal/error/warn/info/debug/trace) |
| `LOGWEAVE_CLUSTERER_TIMEOUT_MS` | No | `500` | Clusterer call timeout (raise for Docker) |
| `LOGWEAVE_RATE_LIMIT_RPM` | No | `300` | Rate limit per API key (requests/min) |
| `LOGWEAVE_RATE_LIMIT_TENANT_RPM` | No | `600` | Rate limit per tenant (requests/min) |
| `LOGWEAVE_RATE_LIMIT_INGEST_RPM` | No | `600` | Ingest endpoint rate limit (requests/min) |
| `LOGWEAVE_MAX_CONCURRENT_QUERIES` | No | `8` | Max concurrent ClickHouse queries |
| `LOGWEAVE_RECOVERY_ENABLED` | No | `true` | Re-cluster unclustered logs |
| `LOGWEAVE_RECOVERY_INTERVAL_MS` | No | `60000` | Recovery check interval |
| `LOGWEAVE_RETENTION_ENABLED` | No | `true` | Auto-delete data older than retention period |
| `LOGWEAVE_SHUTDOWN_TIMEOUT_MS` | No | `10000` | Graceful shutdown timeout |

### Clusterer (`LOGWEAVE_*`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOGWEAVE_DRAIN3_SIM_TH` | No | `0.4` | Default clustering sensitivity (0.0-1.0) |
| `LOGWEAVE_DRAIN3_DEPTH` | No | `4` | Drain3 tree depth |
| `LOGWEAVE_DRAIN3_MAX_CLUSTERS` | No | `10000` | Max clusters per tenant |
| `LOGWEAVE_MAX_CONCURRENT_REQUESTS` | No | `4` | Max concurrent cluster requests |
| `LOGWEAVE_MAX_TENANTS` | No | `200` | Max concurrent tenants |
| `LOGWEAVE_CHECKPOINT_HMAC_KEY` | Recommended | — | HMAC key for checkpoint integrity |

### Dashboard (`VITE_*`, build-time)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_LOGWEAVE_API_URL` | No | `""` (same origin) | API URL (empty = served by API) |
| `VITE_LOGWEAVE_API_KEY` | No | — | API key (baked into JS bundle) |
| `VITE_POLL_INTERVAL_MS` | No | `60000` | Dashboard polling interval |

## Troubleshooting

**Services won't start:**
```bash
docker compose -f docker-compose.prod.yml logs
```
Look for errors in ClickHouse first — the API and clusterer depend on it.

**API returns 401:**
Check that `LOGWEAVE_API_KEYS` is valid JSON and your key matches.

**Dashboard shows "Waiting for data":**
Send a test log with curl (see above), then refresh. The onboarding card will update.

**Clusterer timeout errors:**
Increase `LOGWEAVE_CLUSTERER_TIMEOUT_MS` (default 500ms is tight for Docker networks).
The production template uses 2000ms.

**ClickHouse out of memory:**
Increase the memory limit in `docker-compose.prod.yml` or add swap.
