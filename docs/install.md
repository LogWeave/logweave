# LogWeave — Install Guide

LogWeave runs as a self-hosted Docker stack. Pick the profile that matches how you'll use it:

- **[Local](#local-profile)** — everything on your laptop, MCP at localhost. Good for solo dev or evaluation.
- **[Team / Remote](#team--remote-profile)** — backend on a server (EC2, VPS, etc.), dashboard at a real URL, MCP from any developer's machine.

---

## Local Profile

### Prerequisites

- Docker Engine 24+ and Docker Compose v2
- Tested on Linux, macOS, and Windows with Docker Desktop (or WSL2)
- 6 GB RAM minimum (8 GB recommended)
- 10 GB disk for ClickHouse data
- `openssl` (preinstalled on Linux/macOS, available on Windows via Git Bash or WSL2)

### 1. Clone and configure

```bash
git clone https://github.com/logweave/logweave.git
cd logweave
cp .env.production.example .env
```

Generate the three secrets first, then paste the literal output into `.env`:

```bash
# Generate an API key (32-byte hex string)
openssl rand -hex 32

# Generate an encryption key (32-byte hex string)
openssl rand -hex 32

# Generate a ClickHouse password (16-byte hex string)
openssl rand -hex 16

# Compute the SHA256 of the ClickHouse password
echo -n "<paste-the-clickhouse-password-from-above>" | sha256sum | cut -d' ' -f1
```

Edit `.env` and replace the placeholder values with the literal hex strings you just generated:

```bash
# Required — your generated API key, mapped to a tenant name
LOGWEAVE_API_KEYS={"<paste-32-byte-hex-here>":"my-org"}

# Required — your generated encryption key
LOGWEAVE_ENCRYPTION_KEY=<paste-32-byte-hex-here>

# Required — ClickHouse credentials (kept inside Docker network, not exposed)
LOGWEAVE_CLICKHOUSE_USER=logweave
LOGWEAVE_CLICKHOUSE_PASSWORD=<paste-16-byte-hex-here>
CLICKHOUSE_PASSWORD_SHA256=<paste-sha256-hash-here>
```

### 2. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

First start downloads the ClickHouse image and builds the API + clusterer containers from source. Expect **3-5 minutes** the first time. Subsequent starts are fast.

Verify all three services are healthy:

```bash
docker compose -f docker-compose.prod.yml ps
```

You should see `logweave-clickhouse-1`, `logweave-clusterer-1`, and `logweave-api-1` all reporting `Up (healthy)`. If any container is restarting or unhealthy, check its logs: `docker compose -f docker-compose.prod.yml logs <name>`.

### 3. Open the dashboard

Navigate to `http://localhost:3000`.

**First login:** the API generates a random one-time admin password on first start. Retrieve it one of two ways:

```bash
# Option A — from the API container logs
docker compose -f docker-compose.prod.yml logs api | grep -A 3 "LOGWEAVE BOOTSTRAP"

# Option B — from the credentials file (auto-deleted after first password change)
docker compose -f docker-compose.prod.yml exec api cat /data/bootstrap-credentials.txt
```

Log in with `admin` and that password. You will be prompted to set a new password immediately. The bootstrap credentials file is automatically deleted once you've set a real password.

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
        "LOGWEAVE_API_KEY": "<paste-the-api-key-from-LOGWEAVE_API_KEYS-in-.env>"
      }
    }
  }
}
```

The `LOGWEAVE_API_KEY` is the 32-byte hex string you generated in step 1 — the one inside `LOGWEAVE_API_KEYS={"<this-part>":"my-org"}`.

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

Generate the secrets first (run each command, copy the output):

```bash
# API key (32 bytes hex)
openssl rand -hex 32

# Encryption key (16 bytes hex)
openssl rand -hex 16

# ClickHouse password (16 bytes hex)
CH_PASS=$(openssl rand -hex 16) && echo "$CH_PASS"

# SHA256 of the ClickHouse password (must match)
echo -n "$CH_PASS" | sha256sum | cut -d' ' -f1

# Checkpoint HMAC key (recommended)
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Edit `.env` and paste the literal hex strings — do NOT leave `$(...)` substitutions in the file:

```bash
# REQUIRED — one key per service/integration (not per user — users log in with password)
LOGWEAVE_API_KEYS={"<paste-api-key>":"my-org"}

# REQUIRED — enables dashboard login, TOTP, and connector encryption
LOGWEAVE_ENCRYPTION_KEY=<paste-encryption-key>

# REQUIRED for production — ClickHouse authentication
LOGWEAVE_CLICKHOUSE_USER=logweave
LOGWEAVE_CLICKHOUSE_PASSWORD=<paste-ch-password>
CLICKHOUSE_PASSWORD_SHA256=<paste-sha256-of-ch-password>

# RECOMMENDED — checkpoint integrity
LOGWEAVE_CHECKPOINT_HMAC_KEY=<paste-hmac-key>
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

> **Set `LOGWEAVE_TRUST_PROXY=true`** whenever the API runs behind a reverse
> proxy like this (it defaults to `true` in `docker-compose.prod.yml`). Without
> it the API sees every request as coming from the proxy, so the login rate
> limit and account lockout key on a single IP instead of the real client.
> Leave it unset/`false` only if the API is exposed directly with no proxy.

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

**First login:** the API generates a random one-time admin password on first start. Retrieve it on the server one of two ways:

```bash
# Option A — from the API container logs
docker compose -f docker-compose.prod.yml logs api | grep -A 3 "LOGWEAVE BOOTSTRAP"

# Option B — from the credentials file (auto-deleted after first password change)
docker compose -f docker-compose.prod.yml exec api cat /data/bootstrap-credentials.txt
```

Log in with `admin` and the password from either source. You will be prompted to set a new password immediately. The bootstrap credentials file is automatically deleted once you've set a real password — after that point the original password is gone.

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
      endpoint: "https://logweave.acme.com/v1/ingest/batch",
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

### Durability

By **default**, ingest is **synchronous with no durable queue**. Each batch is
parsed, clustered, and written to ClickHouse within the request. If ClickHouse is
unavailable, the API responds **`503 Service Unavailable` with a `Retry-After: 30`
header** — it does **not** queue the events. The `@logweave/transport` SDK honors
`Retry-After` and retries the batch; events are only lost if the outage outlasts
the SDK's retry budget (and OTLP/`curl` callers must implement their own retry).

For guaranteed durability there are two options:

- **Opt-in durable archive (built in).** Set `LOGWEAVE_VECTOR_ARCHIVE_URL` (with
  `LOGWEAVE_ARCHIVE_BUCKET`) to forward each batch to [Vector](https://vector.dev)
  for durable S3 archival and cluster **asynchronously** off the request path
  instead of inline. See the environment reference below.
- **Buffer in front.** Put a buffering collector (Vector or the OpenTelemetry
  Collector with a persistent queue/disk buffer) in front of `/v1/ingest/batch`
  so it absorbs storage outages until ClickHouse recovers.

---

## Backups

`docker-compose.prod.yml` registers a `backups` disk in ClickHouse (mounted at `/var/lib/clickhouse/backups/` inside the container, which lives on the `clickhouse_data` Docker volume). Backups are taken and restored with ClickHouse's native commands and survive container restarts.

**Online backup (no downtime) — recommended:**

```bash
TODAY=$(date +%Y%m%d)
docker compose -f docker-compose.prod.yml exec clickhouse \
  clickhouse-client --query "BACKUP DATABASE logweave TO Disk('backups', 'logweave-${TODAY}.zip')"
```

The archive is written to `/var/lib/clickhouse/backups/logweave-YYYYMMDD.zip` inside the container. Copy it off-host:

```bash
docker compose -f docker-compose.prod.yml cp \
  clickhouse:/var/lib/clickhouse/backups/logweave-${TODAY}.zip ./
```

To restore (place the archive in the same path inside the container first if you copied it off-host):

```bash
docker compose -f docker-compose.prod.yml cp ./logweave-YYYYMMDD.zip \
  clickhouse:/var/lib/clickhouse/backups/
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

### Scaling (beta)

Run **one replica of each service** for the beta. The clusterer holds per-tenant Drain3 state in memory and the API keeps in-memory anomaly counters, so neither can be horizontally scaled yet — `docker compose up --scale clusterer=N` (or `--scale api=N`) would fragment clustering state and duplicate alerts. Scale **up** (a larger instance), not **out**, until multi-replica support lands post-beta.

---

## Environment Variable Reference

### API Server (`LOGWEAVE_*`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOGWEAVE_API_KEYS` | Yes | — | JSON mapping API keys to tenant IDs |
| `LOGWEAVE_ENCRYPTION_KEY` | Yes | — | 32+ char key (use `openssl rand -hex 32`) — roots session/CSRF/TOTP/API-key HMAC and connector encryption |
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
| `LOGWEAVE_FILESYSTEM_ROOTS` | No | — | Comma-separated absolute dirs a filesystem connector's `basePath` may read from. Empty ⇒ filesystem connectors disabled (fail closed) |

#### Durable archive (optional — see [Durability](#durability))

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOGWEAVE_ARCHIVE_BUCKET` | No | — | Customer S3 bucket for durable archive / drill-down (#275). Auth via the instance role (default credential chain) |
| `LOGWEAVE_VECTOR_ARCHIVE_URL` | No | — | Vector endpoint for durable-archive ingest. When set (requires the archive bucket), ingest forwards batches to Vector→S3 and clusters async off the hot path. Auto-enables the reconciliation sweep |
| `LOGWEAVE_ARCHIVE_RECONCILE_ENABLED` | No | auto | Force the archive reconciliation sweep as a standalone backstop. Auto-forced on when `LOGWEAVE_VECTOR_ARCHIVE_URL` is set |
| `AWS_REGION` | No | `us-east-1` | AWS region for the archive bucket |

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

**Forgot the admin password and no other admin to reset it:**

You have three paths, in order of preference:

```bash
# 1. If the credentials file still exists (you haven't changed the password yet)
docker compose -f docker-compose.prod.yml exec api cat /data/bootstrap-credentials.txt

# 2. Reset the admin password without losing any data (logs, templates, rules stay intact)
docker compose -f docker-compose.prod.yml exec api node dist/scripts/reset-admin-password.js admin

# 3. Last resort — wipe the users table and let bootstrap regenerate the default admin
#    (No log/template/rule data is touched. Only the dashboard user accounts are reset.)
docker compose -f docker-compose.prod.yml exec clickhouse clickhouse-client --query "TRUNCATE TABLE logweave.dashboard_users"
docker compose -f docker-compose.prod.yml restart api
# Then check the API logs for the new bootstrap password (see step 3 of the install)
```

**An admin needs to reset another user's password:**

Use the dashboard: **Settings → Team → click the user → Reset Password**. No CLI needed.
