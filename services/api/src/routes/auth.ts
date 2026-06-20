import { Router } from 'express'
import { Secret, TOTP } from 'otpauth'
import type pino from 'pino'
import QRCode from 'qrcode'
import { z } from 'zod'
import { clearBootstrapCredentials } from '../auth/bootstrap-credentials.js'
import { LockoutTracker } from '../auth/lockout.js'
import {
  dummyVerify,
  generateRecoveryCodes,
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
} from '../auth/passwords.js'
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  type SessionProvider,
} from '../auth/session.js'
import type { UserStore } from '../auth/user-store.js'
import { decrypt, encrypt } from '../crypto.js'
import { insertAuditEvent } from '../db/audit-queries.js'
import type { DbClient } from '../db/client.js'
import { AppError, notFound } from '../errors.js'
import { HttpStatus } from '../http-status.js'
import { getClientIp } from '../middleware/client-ip.js'
import { createIpRateLimiter } from '../middleware/ip-rate-limit.js'
import { validateBody } from '../middleware/validate.js'

export interface AuthDeps {
  userStore: UserStore
  sessionProvider: SessionProvider
  db: DbClient
  logger: pino.Logger
  totpEncryptionKey: Buffer
  isProduction: boolean
}

const FAILED_LOGIN_DELAY_MS = 500

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1),
  totpCode: z.string().max(32).optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
})

const createUserSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(12),
  tenantId: z.string().min(1).max(128),
  role: z.enum(['admin', 'viewer']),
})

const resetPasswordSchema = z.object({
  newPassword: z.string().min(12),
})

export function authRoutes(deps: AuthDeps): Router {
  const router = Router()
  const lockout = new LockoutTracker()

  // Per-IP rate limit on the login endpoint to prevent unauthenticated
  // username enumeration / credential stuffing across different usernames.
  // The per-username|IP lockout in LockoutTracker handles single-user brute
  // force; this guards against high-velocity attacks across many usernames.
  const loginIpLimiter = createIpRateLimiter(30)

  // POST /auth/session — login
  router.post('/auth/session', loginIpLimiter, validateBody(loginSchema), async (req, res) => {
    const { username, password, totpCode } = req.body as z.infer<typeof loginSchema>
    const sourceIp = getClientIp(req)

    // Check lockout (keyed on username+sourceIp — see LockoutTracker)
    if (lockout.isLocked(username, sourceIp)) {
      const retryAfter = lockout.lockoutSecondsRemaining(username, sourceIp)
      res
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .set('Retry-After', String(retryAfter))
        .json({
          error: { code: 'LOCKED_OUT', message: 'Too many failed attempts. Try again later.' },
        })
      return
    }

    // Find user across tenants. Multiple matches → ambiguous; reject without
    // an oracle (treat like invalid credentials).
    const candidates = await deps.userStore.findAllByUsername(username)
    if (candidates.length > 1) {
      deps.logger.warn(
        { username, tenantCount: candidates.length },
        'Ambiguous login: username exists in multiple tenants — rejecting',
      )
      await dummyVerify()
      await delay(FAILED_LOGIN_DELAY_MS)
      lockout.recordFailure(username, sourceIp)
      auditLogin(deps, '', username, sourceIp, false, 'ambiguous_username')
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
      })
      return
    }
    const user = candidates[0] ?? null

    // Timing normalization: always run scrypt
    if (!user) {
      await dummyVerify()
      await delay(FAILED_LOGIN_DELAY_MS)
      lockout.recordFailure(username, sourceIp)
      auditLogin(deps, '', username, sourceIp, false, 'user_not_found')
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
      })
      return
    }

    // Verify password
    const passwordValid = await verifyPassword(password, user.passwordHash)
    if (!passwordValid) {
      await delay(FAILED_LOGIN_DELAY_MS)
      lockout.recordFailure(username, sourceIp)
      auditLogin(deps, user.tenantId, username, sourceIp, false, 'wrong_password')
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
      })
      return
    }

    // Verify TOTP if enabled (same 401 response — no oracle)
    if (user.totpEnabled) {
      if (!totpCode) {
        await delay(FAILED_LOGIN_DELAY_MS)
        lockout.recordFailure(username, sourceIp, true)
        auditLogin(deps, user.tenantId, username, sourceIp, false, 'totp_required')
        res.status(HttpStatus.UNAUTHORIZED).json({
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
        })
        return
      }

      const totpValid = await verifyTotp(user.totpSecret, totpCode, deps.totpEncryptionKey)
      if (!totpValid) {
        // Try recovery code (strip dashes, verify against stored hashes)
        const stripped = totpCode.replace(/-/g, '')
        let recoveryUsed = false
        if (user.recoveryCodes) {
          try {
            const storedHashes = JSON.parse(user.recoveryCodes) as string[]
            for (let i = 0; i < storedHashes.length; i++) {
              const hash = storedHashes[i]
              if (hash && (await verifyPassword(stripped, hash))) {
                // Consume the code — remove from list
                storedHashes.splice(i, 1)
                await deps.userStore.updateTotp(
                  user.userId,
                  user.totpSecret,
                  JSON.stringify(storedHashes),
                  true,
                )
                recoveryUsed = true
                auditAuth(deps, user.tenantId, username, 'auth.recovery_code.used')
                break
              }
            }
          } catch {
            /* malformed recovery codes — ignore */
          }
        }

        if (!recoveryUsed) {
          await delay(FAILED_LOGIN_DELAY_MS)
          lockout.recordFailure(username, sourceIp, true)
          auditLogin(deps, user.tenantId, username, sourceIp, false, 'wrong_totp')
          res.status(HttpStatus.UNAUTHORIZED).json({
            error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
          })
          return
        }
      }
    }

    // Success
    lockout.recordSuccess(username, sourceIp)
    await deps.userStore.updateLastLogin(user.userId)
    auditLogin(deps, user.tenantId, username, sourceIp, true)

    const cookie = deps.sessionProvider.createSession({
      userId: user.userId,
      tenantId: user.tenantId,
      role: user.role,
      sessionVersion: user.sessionVersion,
    })

    res.cookie(SESSION_COOKIE_NAME, cookie, {
      ...SESSION_COOKIE_OPTIONS,
      secure: deps.isProduction,
    })

    res.status(HttpStatus.OK).json({
      data: {
        userId: user.userId,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        totpEnabled: user.totpEnabled,
      },
    })
  })

  // DELETE /auth/session — logout
  router.delete('/auth/session', (_req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    res.status(HttpStatus.NO_CONTENT).end()
  })

  // GET /auth/me — session check
  router.get('/auth/me', async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
      })
      return
    }

    const user = await deps.userStore.findById(session.userId)
    if (!user || user.sessionVersion !== session.sessionVersion) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'SESSION_INVALID', message: 'Session expired' },
      })
      return
    }

    res.status(HttpStatus.OK).json({
      data: {
        userId: user.userId,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        totpEnabled: user.totpEnabled,
      },
    })
  })

  // PUT /auth/password — change own password
  router.put('/auth/password', validateBody(changePasswordSchema), async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
      })
      return
    }

    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>

    const policyError = validatePasswordPolicy(newPassword)
    if (policyError) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'WEAK_PASSWORD', policyError)
    }

    const user = await deps.userStore.findById(session.userId)
    if (!user) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
      })
      return
    }

    const valid = await verifyPassword(currentPassword, user.passwordHash)
    if (!valid) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' },
      })
      return
    }

    const newHash = await hashPassword(newPassword)
    await deps.userStore.updatePassword(user.userId, newHash)

    // First password change wipes the bootstrap-credentials file (no-op if it
    // doesn't exist or wasn't created in the first place). Keeps the secret
    // on disk for the minimum possible time.
    clearBootstrapCredentials(deps.logger)

    // Issue new cookie with bumped sessionVersion
    const newCookie = deps.sessionProvider.createSession({
      userId: user.userId,
      tenantId: user.tenantId,
      role: user.role,
      sessionVersion: user.sessionVersion + 1,
    })
    res.cookie(SESSION_COOKIE_NAME, newCookie, {
      ...SESSION_COOKIE_OPTIONS,
      secure: deps.isProduction,
    })

    auditAuth(deps, user.tenantId, user.username, 'auth.password.change')
    res.status(HttpStatus.OK).json({ data: { changed: true } })
  })

  // POST /auth/totp/setup — generate QR code
  router.post('/auth/totp/setup', async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
      })
      return
    }

    const user = await deps.userStore.findById(session.userId)
    if (!user) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
      })
      return
    }

    const secret = new Secret()
    const totp = new TOTP({
      issuer: 'LogWeave',
      label: user.username,
      secret,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    })

    const uri = totp.toString()
    const qrCodeDataUrl = await QRCode.toDataURL(uri)

    // Store secret temporarily (not enabled yet — user must confirm).
    // totpEncryptionKey is already HKDF-derived; encrypt() HKDF-derives it again
    // from its hex form. The extra derivation is harmless and gives TOTP its own
    // stable key domain — we intentionally do NOT re-key, since that would orphan
    // every TOTP secret already encrypted under the current scheme.
    const encryptedSecret = await encrypt(secret.base32, deps.totpEncryptionKey.toString('hex'))
    await deps.userStore.updateTotp(user.userId, encryptedSecret, user.recoveryCodes, false)

    res.status(HttpStatus.OK).json({
      data: {
        qrCodeDataUrl,
        secret: secret.base32,
        uri,
      },
    })
  })

  // POST /auth/totp/confirm — verify setup with code
  const confirmTotpSchema = z.object({ code: z.string().length(6) })
  router.post('/auth/totp/confirm', validateBody(confirmTotpSchema), async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
      })
      return
    }

    const { code } = req.body as z.infer<typeof confirmTotpSchema>
    const user = await deps.userStore.findById(session.userId)
    if (!user?.totpSecret) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'NO_TOTP_PENDING',
        'Call POST /v1/auth/totp/setup first',
      )
    }

    const valid = await verifyTotp(user.totpSecret, code, deps.totpEncryptionKey)
    if (!valid) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_CODE',
        'Invalid TOTP code — check your authenticator app',
      )
    }

    // Generate recovery codes
    const { display, hashed } = await generateRecoveryCodes()
    await deps.userStore.updateTotp(user.userId, user.totpSecret, JSON.stringify(hashed), true)

    auditAuth(deps, user.tenantId, user.username, 'auth.totp.setup')

    res.status(HttpStatus.OK).json({
      data: { enabled: true, recoveryCodes: display },
    })
  })

  // DELETE /auth/totp — disable TOTP
  const disableTotpSchema = z.object({ password: z.string().min(1) })
  router.delete('/auth/totp', validateBody(disableTotpSchema), async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
      })
      return
    }

    const { password } = req.body as z.infer<typeof disableTotpSchema>
    const user = await deps.userStore.findById(session.userId)
    if (!user) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' },
      })
      return
    }

    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Password is incorrect' },
      })
      return
    }

    await deps.userStore.updateTotp(user.userId, '', '', false)
    auditAuth(deps, user.tenantId, user.username, 'auth.totp.disable')

    res.status(HttpStatus.OK).json({ data: { enabled: false } })
  })

  // GET /auth/users — list users (admin only)
  router.get('/auth/users', async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session || session.role !== 'admin') {
      res.status(HttpStatus.FORBIDDEN).json({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      })
      return
    }

    const users = await deps.userStore.listByTenant(session.tenantId)
    res.status(HttpStatus.OK).json({
      data: users.map((u) => ({
        userId: u.userId,
        username: u.username,
        tenantId: u.tenantId,
        role: u.role,
        totpEnabled: u.totpEnabled,
        lastLoginAt: u.lastLoginAt,
      })),
    })
  })

  // POST /auth/users — create user (admin only, own tenant)
  router.post('/auth/users', validateBody(createUserSchema), async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session || session.role !== 'admin') {
      res.status(HttpStatus.FORBIDDEN).json({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      })
      return
    }

    const body = req.body as z.infer<typeof createUserSchema>

    // Admin can only create users in their own tenant
    if (body.tenantId !== session.tenantId) {
      res.status(HttpStatus.FORBIDDEN).json({
        error: { code: 'FORBIDDEN', message: 'Cannot create users in a different tenant' },
      })
      return
    }

    // Check if username already exists in this tenant
    const existing = await deps.userStore.findByUsername(body.tenantId, body.username)
    if (existing) {
      res.status(HttpStatus.CONFLICT).json({
        error: { code: 'USERNAME_TAKEN', message: 'Username already exists' },
      })
      return
    }

    const user = await deps.userStore.createUser(body)
    auditAuth(deps, session.tenantId, session.userId, 'auth.user.create', body.username)

    res.status(HttpStatus.CREATED).json({
      data: {
        userId: user.userId,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
      },
    })
  })

  // DELETE /auth/users/:id — delete user (admin only)
  router.delete('/auth/users/:id', async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session || session.role !== 'admin') {
      res.status(HttpStatus.FORBIDDEN).json({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      })
      return
    }

    const targetId = req.params.id as string
    if (targetId === session.userId) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'CANNOT_DELETE_SELF',
        'Cannot delete your own account',
      )
    }

    const target = await deps.userStore.findById(targetId)
    if (!target || target.tenantId !== session.tenantId) {
      throw notFound('User not found')
    }

    await deps.userStore.deleteUser(targetId)
    auditAuth(deps, session.tenantId, session.userId, 'auth.user.delete', target.username)

    res.status(HttpStatus.NO_CONTENT).end()
  })

  // PUT /auth/users/:id/password — reset user password (admin only)
  router.put('/auth/users/:id/password', validateBody(resetPasswordSchema), async (req, res) => {
    const session = getSessionFromCookie(req, deps)
    if (!session || session.role !== 'admin') {
      res.status(HttpStatus.FORBIDDEN).json({
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      })
      return
    }

    const targetId = req.params.id as string
    const { newPassword } = req.body as z.infer<typeof resetPasswordSchema>

    const target = await deps.userStore.findById(targetId)
    if (!target || target.tenantId !== session.tenantId) {
      throw notFound('User not found')
    }

    const newHash = await hashPassword(newPassword)
    await deps.userStore.updatePassword(targetId, newHash, true)
    auditAuth(deps, session.tenantId, session.userId, 'auth.password.reset', target.username)

    res.status(HttpStatus.OK).json({ data: { reset: true } })
  })

  return router
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionFromCookie(req: { cookies?: Record<string, string> }, deps: AuthDeps) {
  const cookie = req.cookies?.[SESSION_COOKIE_NAME]
  if (!cookie) return null
  return deps.sessionProvider.validateSession(cookie)
}

async function verifyTotp(
  encryptedSecret: string,
  code: string,
  encryptionKey: Buffer,
): Promise<boolean> {
  try {
    const secret = await decrypt(encryptedSecret, encryptionKey.toString('hex'))
    const totp = new TOTP({
      secret: Secret.fromBase32(secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    })
    const delta = totp.validate({ token: code, window: 1 })
    return delta !== null
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function auditLogin(
  deps: AuthDeps,
  tenantId: string,
  username: string,
  sourceIp: string,
  success: boolean,
  reason?: string,
): void {
  const action = success ? 'auth.login.success' : 'auth.login.failure'
  insertAuditEvent(deps.db, tenantId || 'system', {
    keyId: username,
    action,
    sourceIp,
    details: reason ? JSON.stringify({ reason }) : undefined,
  }).catch((err) => {
    deps.logger.warn({ err, action, username }, 'Failed to write audit event')
  })
}

function auditAuth(
  deps: AuthDeps,
  tenantId: string,
  actor: string,
  action: string,
  target?: string,
): void {
  insertAuditEvent(deps.db, tenantId, {
    keyId: actor,
    action,
    details: target ? JSON.stringify({ target }) : undefined,
  }).catch((err) => {
    deps.logger.warn({ err, action, actor }, 'Failed to write audit event')
  })
}
