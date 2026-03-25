# Dashboard Authentication Design Spec (v2 — post security review)

**Date:** 2026-03-25
**Status:** Approved
**Issue:** #143
**Security review:** 2 CRITICAL + 4 HIGH findings addressed in v2

## Goal

Gate the dashboard behind username/password + TOTP authentication so self-hosted deployments are secure without requiring external auth infrastructure. Production logs are sensitive — auth must be robust.

## Approach

Grafana-style default admin account with forced password change on first login. TOTP 2FA via authenticator app (Google Authenticator, Authy, 1Password). Users stored in ClickHouse. Session cookies for dashboard, Bearer tokens for MCP/SDK (unchanged). Decoupled provider interface for future swap to OAuth/SSO.

## Key Decisions

- **Default admin/admin** — forced password change + TOTP setup on first login
- **Password + TOTP** — password is baseline, TOTP is admin-enforced or per-user opt-in
- **Minimum 12-character passwords** — NIST SP 800-63B, no complexity rules
- **TOTP via authenticator app** — no email, no SMS, no external service
- **ClickHouse for user storage** — ReplacingMergeTree, ORDER BY (tenant_id, username)
- **scrypt for password hashing** — N=32768, r=8, p=1, 16-byte salt, 64-byte key
- **HKDF domain-separated keys** — separate derivations for cookie signing vs TOTP encryption
- **Server-side session validity check** — in-memory user cache (60s TTL) prevents deleted/changed users from using stale cookies
- **No TOTP oracle** — TOTP field always shown, same 401 for all failures
- **SameSite=Lax + CSRF token** — allows Slack alert link navigation
- **Admin scoped to own tenant** — cannot create users in other tenants
- **Auth events in audit_log** — all login/password/TOTP/user events logged
- **LOGWEAVE_ENCRYPTION_KEY required** — startup fails without it when auth is enabled

## Scope

**In scope:**
- ClickHouse `dashboard_users` table (ReplacingMergeTree)
- Default admin user auto-created on first startup if no users exist
- Login: `POST /v1/auth/session` (password + TOTP code in single request)
- Logout: `DELETE /v1/auth/session`
- Session check: `GET /v1/auth/me`
- Auth middleware: cookie (with server-side validity check) OR Bearer
- Dashboard login page with password + TOTP fields (TOTP always visible)
- Forced password change + TOTP setup on first login
- TOTP setup: QR code, verification, recovery codes (128-bit, `xxxx-xxxx-xxxx-xxxx`)
- Settings > Team page (admin manages own-tenant users)
- Settings > Security (change password, manage TOTP, regenerate recovery codes)
- Admin "Require 2FA" toggle
- Account lockout: 5 failed attempts (password OR TOTP) → 15 min cooldown
- 500ms delay on failed attempts + always run scrypt (timing normalization)
- CSRF token on state-changing POST/PUT/DELETE
- All auth events written to audit_log
- New dependencies: `cookie-parser`, `otpauth`, `qrcode`

**Out of scope / deferred:**
- OAuth / SSO / SAML
- Email-based password reset or OTP delivery
- SMS-based OTP
- User roles beyond admin/viewer
- Redis/DB session store (in-memory cache + signed cookies for V1)
- Multi-instance lockout coordination (document limitation)

## Design

### 1. Data Model

```sql
CREATE TABLE IF NOT EXISTS logweave.dashboard_users (
  user_id              String,
  username             LowCardinality(String),
  password_hash        String,
  tenant_id            LowCardinality(String),
  role                 LowCardinality(String) DEFAULT 'viewer',
  must_change_password UInt8 DEFAULT 0,
  totp_secret          String DEFAULT '',
  totp_enabled         UInt8 DEFAULT 0,
  recovery_codes       String DEFAULT '',
  session_version      UInt64 DEFAULT 1,
  last_login_at        Nullable(DateTime64(3)),
  version              UInt64,
  is_deleted           UInt8 DEFAULT 0
) ENGINE = ReplacingMergeTree(version, is_deleted)
ORDER BY (tenant_id, username)
```

- `totp_secret`: encrypted with HKDF-derived key (info="logweave-totp-encryption")
- `recovery_codes`: JSON array of scrypt-hashed 128-bit codes
- `session_version`: bumped on password change, TOTP change, admin reset — causes cookie rejection
- ORDER BY (tenant_id, username): per-tenant username uniqueness, matches schema conventions

### 2. Key Derivation (HKDF domain separation)

```typescript
import { hkdf } from 'node:crypto'

// From single LOGWEAVE_ENCRYPTION_KEY, derive separate keys:
const sessionSigningKey = await hkdf('sha256', encryptionKey, '', 'logweave-session-hmac', 32)
const totpEncryptionKey = await hkdf('sha256', encryptionKey, '', 'logweave-totp-encryption', 32)
const csrfTokenKey = await hkdf('sha256', encryptionKey, '', 'logweave-csrf-token', 32)
```

Compromise of one derived key does not compromise the others.

### 3. Default Admin Bootstrap

On startup, after schema init:
1. Query `SELECT count() FROM logweave.dashboard_users FINAL WHERE is_deleted = 0`
2. If 0 users → insert default admin:
   - username: `admin`, password_hash: scrypt("admin"), tenant_id: first tenant from LOGWEAVE_API_KEYS
   - role: `admin`, must_change_password: 1, totp_enabled: 0

### 4. Password Hashing

```typescript
// scrypt: N=32768 (2^15), r=8, p=1, salt=16 bytes, keylen=64 bytes
// Format: "salt_hex:hash_hex"
// Always run scrypt even for nonexistent users (timing normalization)
```

**Password policy:** Minimum 12 characters. No complexity rules (per NIST SP 800-63B).

### 5. Session Cookies + Server-Side Validity

Cookie payload: `{ userId, tenantId, role, sessionVersion, exp }`
Signed with HMAC-SHA256 using `sessionSigningKey` (HKDF-derived).

Flags: `httpOnly`, `secure` (production), `sameSite=lax`, `maxAge=86400` (24h), `path=/`

**Server-side check (fixes C1):**
- In-memory cache: `userId → { tenantId, role, sessionVersion, isDeleted }` with 60s TTL
- On each cookie-authenticated request: validate HMAC → check cache → if cache miss, query ClickHouse FINAL → reject if deleted or sessionVersion mismatch
- Effect: deleted users lose access within 60 seconds, password changes invalidate sessions within 60 seconds

### 6. Login Flow (no TOTP oracle — fixes H3)

Login page always shows: username, password, TOTP code (labeled "optional if 2FA not enabled").

`POST /v1/auth/session` body: `{ username, password, totpCode? }`

Server logic:
1. Check lockout → 429 if locked
2. Look up user (or use dummy scrypt for timing normalization if not found)
3. Verify password with scrypt
4. If user has TOTP enabled → verify totpCode (or recovery code)
5. If TOTP not enabled → ignore totpCode field
6. **All failures return identical 401** `{ error: "Invalid credentials" }` after 500ms delay
7. On success: set cookie, update last_login_at, write audit event, clear lockout counter

No distinguishable responses between wrong username, wrong password, wrong TOTP, or missing TOTP.

### 7. Account Lockout

In-memory: `username → { failCount, lockedUntil }`
- Any failed attempt (password OR TOTP) increments counter
- 5 failures → locked for 15 minutes
- TOTP-specific: 3 consecutive wrong TOTP codes → lock (separate tighter limit)
- Successful login → clear counter
- Server restart → counters reset (documented limitation for V1 single-instance)

### 8. TOTP

Setup: generate 20-byte secret → otpauth:// URI → QR code → user confirms with 6-digit code → encrypt secret (HKDF-derived key), hash 10 recovery codes, store.

Validation: ±1 time window (90 seconds total). Recovery codes: 128-bit random, displayed as `xxxx-xxxx-xxxx-xxxx` (alphanumeric), hashed with scrypt, consumed on use.

"View recovery codes" = regenerate (old codes destroyed, new ones generated and displayed once).

### 9. CSRF Protection

SameSite=Lax allows cookies on same-site navigations (Slack links work) but not cross-origin POST.

Additionally: CSRF token in a `X-CSRF-Token` header, validated on POST/PUT/DELETE. Token derived from session + CSRF key via HMAC. Frontend fetches token from `GET /v1/auth/me` response and includes in all mutations.

### 10. Audit Trail

All auth events written to existing `audit_log` table:
- `auth.login.success`, `auth.login.failure` (with reason: wrong_password, wrong_totp, locked_out, user_not_found)
- `auth.logout`
- `auth.password.change`, `auth.password.reset`
- `auth.totp.setup`, `auth.totp.disable`
- `auth.user.create`, `auth.user.delete`
- `auth.lockout.triggered`

Each event includes: timestamp, username, action, source IP, tenant_id, success/failure.

### 11. API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /v1/auth/session | None | Login (password + TOTP) |
| DELETE | /v1/auth/session | Cookie | Logout |
| GET | /v1/auth/me | Cookie | Session check + CSRF token |
| PUT | /v1/auth/password | Cookie | Change own password |
| POST | /v1/auth/totp/setup | Cookie | Generate QR + secret |
| POST | /v1/auth/totp/confirm | Cookie | Verify setup, enable TOTP |
| DELETE | /v1/auth/totp | Cookie | Disable TOTP (requires password) |
| GET | /v1/auth/users | Cookie+Admin | List users in own tenant |
| POST | /v1/auth/users | Cookie+Admin | Create user (own tenant only) |
| DELETE | /v1/auth/users/:id | Cookie+Admin | Remove user |
| PUT | /v1/auth/users/:id/password | Cookie+Admin | Reset user password |

### 12. Dashboard Pages

**Login (`/login`):** Username, password, TOTP code fields. Generic error on failure. Lockout countdown.

**First login flow:** Login → change password → setup TOTP (QR + verify) → save recovery codes → dashboard.

**Settings > Security:** Change password, enable/disable TOTP, regenerate recovery codes.

**Settings > Team (admin):** User table, add/remove users, reset passwords, 2FA status, "Require 2FA" toggle.

### 13. Decoupling

```typescript
interface SessionProvider {
  createSession(user: SessionUser): string
  validateSession(cookie: string): SessionUser | null
}

interface UserStore {
  findByUsername(tenantId: string, username: string): Promise<User | null>
  createUser(user: NewUser): Promise<User>
  updatePassword(userId: string, hash: string): Promise<void>
  listByTenant(tenantId: string): Promise<User[]>
  // ...
}
```

V1: `HmacSessionProvider` + `ClickHouseUserStore`. Swap independently.

## Test Strategy

- Login correct credentials → cookie set, audit logged
- Login wrong password → 401, same error, 500ms delay, scrypt still runs
- Login wrong username → 401, same error, timing indistinguishable
- Login with TOTP → success when code correct
- Login with wrong TOTP → 401, same error (no oracle)
- Login without TOTP code when required → 401, same error
- Lockout after 5 failures → 429, audit logged
- Session cookie rejected after user deleted (within 60s cache TTL)
- Session cookie rejected after password change (sessionVersion mismatch)
- Cookie tampering → 401
- HKDF keys are distinct (session key ≠ TOTP key)
- Admin cannot create user in different tenant → 403
- Recovery code works once, rejected on reuse
- CSRF token required on mutations
- Bearer auth unaffected (MCP/SDK)
- Default admin bootstrap on empty database
- Password policy: reject < 12 chars

## Open Questions

None.
