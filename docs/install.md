# LogWeave — Install Guide

LogWeave runs as a self-hosted Docker stack. Pick the profile that matches how you'll use it:

- **[Local](#local-profile)** — everything on your laptop, MCP at localhost. Good for solo dev or evaluation.
- **[Team / Remote](#team--remote-profile)** — backend on a server (EC2, VPS, etc.), dashboard at a real URL, MCP from any developer's machine.

---

## Local Profile

### Prerequisites

- Docker Engine 24+ and Docker Compose v2
- 6 GB RAM minimum (8 GB recommended)
- 10 GB disk for ClickHouse data

### 1. Clone and configure

```bash
git clone https://github.com/logweave/logweave.git
cd logweave
cp .env.production.example .env
```

Edit `.env` — the two required values:

```bash
# Generate a secure API key
LOGWEAVE_API_KEYS={"$(openssl rand -hex 32)":"my-org"}

# Generate an encryption key (enables dashboard login + TOTP)
LOGWEAVE_ENCRYPTION_KEY=$(openssl rand -hex 16)
```

### 2. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

### 3. Open the dashboard

Navigate to `http://localhost:3000`.

**First login:** username `admin`, password `admin`. You will be prompted to change your password immediately.

### 4. Connect your AI (MCP)

Add to your editor's MCP config (Claude Code, Cursor, Windsurf):

```json
{
  "mcpServers": {
    "logweave": {
      "command": "npx",
      "args": ["@logweave/mcp"],
      "env": {
        "LOGWEAVE_API_URL": "http://localhost:3000",
        "LOGWEAVE_API_KEY": "your-api-key-from-env"
      }
    }
  }
}
```

Then ask your AI: *"What error patterns are happening in my services?"*

---

## Team / Remote Profile

The backend (API + ClickHouse + Clusterer) runs on a server. The dashboard is served from the same server at a public HTTPS URL. MCP runs on each developer's machine and calls out to that URL.

```
Developer laptop                    Your server (EC2, VPS, etc.)
─────────────────                   ──────────────────────────────
Editor + MCP client ──HTTPS──────►  Caddy (TLS termination)
Browser             ──HTTPS──────►    └─► API + Dashboard :3000
Your services       ──HTTPS──────►    └─► ClickHouse (internal)
                                      └─► Clusterer (internal)
```

### Prerequisites

- A server with 8 GB RAM / 2+ vCPU (AWS t3.large or equivalent)
- 10 GB disk for ClickHouse data
- Docker Engine 24+ and Docker Compose v2
- A domain name (or subdomain) you control — e.g. `logweave.acme.com`
- Ports 80 and 443 open inbound (80 is needed for Let's Encrypt ACME challenge)

### 1. Point your domain at the server

Create an A record at your DNS provider:

```
logweave.acme.com  →  <your-server-public-ip>
```

DNS propagation takes a few minutes. Caddy will fail to get a TLS cert until this is live.

### 2. Clone and configure

On the server:

```bash
git clone https://github.com/logweave/logweave.git
cd logweave
cp .env.production.example .env
```

Edit `.env`:

```bash
# REQUIRED — one key per service/integration (not per user — users log in with password)
LOGWEAVE_API_KEYS={"$(openssl rand -hex 32)":"my-org"}

# REQUIRED — enables dashboard login, TOTP, and connector encryption
LOGWEAVE_ENCRYPTION_KEY=$(openssl rand -hex 16)

# REQUIRED for production — ClickHouse authentication
LOGWEAVE_CLICKHOUSE_USER=logweave
LOGWEAVE_CLICKHOUSE_PASSWORD=$(openssl rand -hex 16)
CLICKHOUSE_PASSWORD_SHA256=$(echo -n "your-password-here" | sha256sum | cut -d' ' -f1)

# RECOMMENDED — checkpoint integrity
LOGWEAVE_CHECKPOINT_HMAC_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
```

### 3. Configure Caddy

Create a `Caddyfile` in the repo root:

```
logweave.acme.com {
    reverse_proxy localhost:3000
}
```

Install and start Caddy (Debian/Ubuntu):

```bash
sudo apt install -y caddy
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy automatically obtains and renews a Let's Encrypt certificate for your domain.

### 4. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

### 5. Verify

```bash
curl https://logweave.acme.com/healthz
# Expected: {"status":"ok"}
```

### 6. Open the dashboard

Navigate to `https://logweave.acme.com` in your browser.

**First login:** username `admin`, password `admin`. You will be prompted to change your password immediately.

---

## User Management

The dashboard has two roles: **admin** (can manage users and API keys) and **viewer** (read-only).

### Add a team member

In the dashboard: **Settings → Users → Add User**. Set a temporary password — the user will be prompted to change it on first login.

Alternatively via API (admin session required):

```bash
curl -X POST https://logweave.acme.com/v1/auth/users \
  -H "Content-Type: application/json" \
  -b "logweave_session=<your-session-cookie>" \
  -d '{
    "username": "alice",
    "password": "TemporaryPassword123!",
    "tenantId": "my-org",
    "role": "viewer"
  }'
```

### Enable TOTP (recommended for team deployments)

Each user can enable TOTP from their profile: **Settings → Security → Enable Authenticator App**. Scan the QR code with any TOTP app (Google Authenticator, 1Password, etc.) and save the recovery codes.

---

## API Keys

API keys are for **machine-to-machine access only** — ingest endpoints, SDK, and MCP. They are not for logging into the dashboard.

**Issue one key per service or integration** so you can revoke individually:

```bash
# Generate a key
openssl rand -hex 32
```

Add it to `LOGWEAVE_API_KEYS` in `.env` and restart the API:

```bash
# .env
LOGWEAVE_API_KEYS={"key-for-auth-service":"my-org","key-for-payments":"my-org","key-for-alice-mcp":"my-org"}

docker compose -f docker-compose.prod.yml restart api
```

---

## Connecting AI (MCP)

Each developer configures MCP on their own machine. The MCP server runs locally and calls the hosted API — nothing extra to deploy.

**Local profile:**
```json
{
  "mcpServers": {
    "logweave": {
      "command": "npx",
      "args": ["@logweave/mcp"],
      "env": {
        "LOGWEAVE_API_URL": "http://localhost:3000",
        "LOGWEAVE_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Team / Remote profile:**
```json
{
  "mcpServers": {
    "logweave": {
      "command": "npx",
      "args": ["@logweave/mcp"],
      "env": {
        "LOGWEAVE_API_URL": "https://logweave.acme.com",
        "LOGWEAVE_API_KEY": "your-personal-api-key"
      }
    }
  }
}
```

Give each developer their own API key (see [API Keys](#api-keys) above) so you can revoke access individually.

To verify the connection, ask your AI:

> *"Use the LogWeave overview tool to show me the system status."*

---

## Sending Logs

Replace `https://logweave.acme.com` with `http://localhost:3000` for the local profile.

### HTTP API (any language)

```bash
curl -X POST https://logweave.acme.com/v1/ingest/batch \
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
      endpoint: "https://logweave.acme.com",
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
    endpoint: https://logweave.acme.com/v1/logs
    headers:
      authorization: "Bearer YOUR_API_KEY"

service:
  pipelines:
    logs:
      exporters: [otlphttp]
```

---

## Backups

**Online backup (no downtime) — recommended:**

```bash
docker compose -f docker-compose.prod.yml exec clickhouse \
  clickhouse-client --query "BACKUP DATABASE logweave TO Disk('backups', 'logweave-$(date +%Y%m%d).zip')"
```

To restore:

```bash
docker compose -f docker-compose.prod.yml exec clickhouse \
  clickhouse-client --query "RESTORE DATABASE logweave FROM Disk('backups', 'logweave-YYYYMMDD.zip')"
```

Schedule via cron. LogWeave data is bounded by TTL (30-day metadata, 365-day audit) so backups stay small.

---

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

ClickHouse data persists across updates. Schema migrations run automatically on startup.

---

## Resource Limits

| Service | Memory | CPU |
|---------|--------|-----|
| ClickHouse | 4 GB | 2 cores |
| API | 512 MB | 1 core |
| Clusterer | 512 MB | 1 core |
| **Total** | **5 GB** | **4 cores** |

An 8 GB / 2 vCPU server is the minimum for production. Increase ClickHouse to 8 GB if you have 50+ services or high log volume. Adjust in `docker-compose.prod.yml` under `deploy.resources.limits`.

---

## Environment Variable Reference

### API Server (`LOGWEAVE_*`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOGWEAVE_API_KEYS` | Yes | — | JSON mapping API keys to tenant IDs |
| `LOGWEAVE_ENCRYPTION_KEY` | Yes | — | 16+ char key — enables dashboard login, TOTP, connector encryption |
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
| `VITE_LOGWEAVE_API_URL` | No | `""` (same origin) | API URL — leave empty when dashboard is served by the API |
| `VITE_POLL_INTERVAL_MS` | No | `60000` | Dashboard polling interval |

---

## Troubleshooting

**Services won't start:**
```bash
docker compose -f docker-compose.prod.yml logs
```
Look for errors in ClickHouse first — the API and clusterer depend on it.

**API returns 401:**
Check that `LOGWEAVE_API_KEYS` is valid JSON and your key matches exactly.

**Dashboard login fails / login page not shown:**
`LOGWEAVE_ENCRYPTION_KEY` must be set. Without it, dashboard auth is disabled and the API logs an error on startup. Check with:
```bash
docker compose -f docker-compose.prod.yml logs api | grep ENCRYPTION
```

**Caddy can't get a TLS certificate:**
Ensure your domain's A record points at the server and ports 80/443 are open. Check Caddy logs:
```bash
sudo journalctl -u caddy -f
```

**Dashboard shows "Waiting for data":**
Send a test log with curl (see [Sending Logs](#sending-logs)), then refresh.

**Clusterer timeout errors:**
Increase `LOGWEAVE_CLUSTERER_TIMEOUT_MS` (default 500ms is tight for Docker networks). The production template uses 2000ms.

**ClickHouse out of memory:**
Increase the memory limit in `docker-compose.prod.yml` or add swap.

**MCP can't connect to remote API:**
- Confirm `LOGWEAVE_API_URL` uses `https://` not `http://`
- Check the API key is in `LOGWEAVE_API_KEYS` on the server
- If the server is inside a private VPC with no public ingress, developers need VPN or SSH tunnel access
