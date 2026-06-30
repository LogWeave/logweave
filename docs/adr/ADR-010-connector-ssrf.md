# ADR-010: Connector SSRF Defense & S3 IAM Trust Model

**Status:** Accepted
**Date:** 2026-06-20
**Issue:** [#251](https://github.com/LogWeave/logweave/issues/251) (documentation of decisions referenced by `connectors.ts` and `docker-compose.dev.yml`)

## Context

Log connectors (S3, Elasticsearch, Loki, filesystem) let a tenant admin point
LogWeave at a log source they control. The target URL/endpoint is therefore
**attacker-influenced**: a malicious or compromised admin could aim a connector
at internal services (`127.0.0.1`, `10.0.0.0/8`), cloud metadata
(`169.254.169.254`), or other tenants' sidecars — a classic SSRF. The
connector-test and fetch paths make real outbound requests, so the URL cannot be
trusted on its face.

S3 connectors additionally need cross-account access to a customer bucket
without LogWeave holding long-lived customer credentials.

## Decision

### 1. SSRF defense is enforced at fetch time on the resolved IP

`services/api/src/connectors/safe-fetch.ts` is the authoritative guard, not the
create-time string check:

- DNS is resolved through a custom `lookup` that **rejects any internal IP at the
  moment the socket connects**. Validating the resolved address used for the
  actual connection closes the DNS-rebinding TOCTOU window (resolve-public,
  connect-internal).
- Redirects are followed **manually**, re-validating every hop, so a `3xx` to an
  internal target is caught.
- Internal ranges (loopback, link-local incl. metadata, RFC1918, CGNAT,
  multicast/reserved, plus IPv4-mapped/compatible IPv6) are blocked. Anything
  unparseable **fails closed** (treated as internal).
- Only `http:`/`https:` schemes are permitted; other protocols are rejected.
- The control is **unconditional** — there is no `NODE_ENV` bypass. The only
  opt-in is an explicit host allowlist, `LOGWEAVE_CONNECTOR_ALLOWED_HOSTS`, for
  self-hosters pointing at a sidecar Loki/Elasticsearch.

The create-time hostname check in `connectors.ts` (`externalUrl`) is **fast
feedback only**; it is intentionally not the security boundary.

### 2. S3 access uses IAM AssumeRole with an external ID, not static keys

Production S3 connectors use a customer-created IAM role that trusts the LogWeave
AWS account, scoped by a per-connector **external ID** (the second factor in the
trust policy). LogWeave assumes the role to read the bucket; it never stores
long-lived customer keys. The `quick-create-url` endpoint generates a
CloudFormation quick-create link plus the external ID. A custom `endpoint` (for
an S3-compatible emulator) has its host **SSRF-validated** with the same
`externalUrl` check as the Loki/ES URLs — internal targets are blocked unless
allowlisted via `LOGWEAVE_CONNECTOR_ALLOWED_HOSTS`. It is **not** gated on
`NODE_ENV`, which silently failed open under the base `docker-compose` (where
`NODE_ENV` is unset), letting `endpoint` reach internal hosts and cloud metadata
(LW-281 F2). Static `accessKeyId`/`secretAccessKey` are only accepted alongside
an `endpoint`.

### 3. Authorization and secret handling

- All mutating/side-effecting connector routes — create, delete,
  `quick-create-url`, and **`POST /connectors/:id/test`** (which makes an
  outbound request) — require `requireAdmin`.
- `GET /connectors` is intentionally **viewer-readable**: it lists connector
  metadata with secrets (`secretAccessKey`, `accessKeyId`, `password`, `apiKey`,
  `externalId`) redacted to `***`. Viewers see connector status but never
  credentials.
- Connector secrets are encrypted at rest with `crypto.ts`.

### 4. Loki query construction

The Loki `streamSelector` is validated at create-time against a LogQL
label-matcher grammar (`{label=~"value", ...}`) so it cannot append arbitrary
LogQL when string-interpolated into a query. The template-derived line-filter
regex has backticks stripped before it is interpolated into the backtick-quoted
LogQL string, closing a breakout vector. `templateToRegex` caps template length
and wildcard count to bound in-process backtracking.

## Consequences

- **Residual risk (accepted):** the IP guard blocks internal *addresses*, not
  *ports*. A connector can still reach an arbitrary port on a **public** host.
  This is acceptable: the host must already resolve to a public IP, and a tenant
  admin reaching a public service on a non-standard port is not a privilege
  escalation against LogWeave.
- **http is permitted, not just https.** Self-hosted Loki/Elasticsearch sidecars
  are commonly plain-http on a trusted network, so forcing https would break
  legitimate deployments. The DNS/IP guard — not the scheme — is what prevents
  internal access.
- Self-hosters reaching an internal sidecar must opt in explicitly via
  `LOGWEAVE_CONNECTOR_ALLOWED_HOSTS`; there is no implicit dev bypass.
- **The S3 `endpoint` only gets the create-time host check, not the fetch-time
  resolved-IP guard.** S3 traffic goes through the AWS SDK, which does its own
  DNS and does not use `safe-fetch.ts`, so a DNS-rebinding endpoint
  (resolve-public, connect-internal) is a theoretical residual. Mitigated by:
  the endpoint is for emulators only, internal hosts require explicit
  allowlisting, and production uses IAM AssumeRole (no endpoint).
