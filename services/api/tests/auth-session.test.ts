import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import pino from 'pino'
import request from 'supertest'
import { LockoutTracker } from '../src/auth/lockout.js'
import { deriveKeys, hashPassword, validatePasswordPolicy, verifyPassword } from '../src/auth/passwords.js'
import { HmacSessionProvider } from '../src/auth/session.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { authRoutes } from '../src/routes/auth.js'
import type { UserStore, DashboardUser } from '../src/auth/user-store.js'
import type { DbClient } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// In-memory UserStore for tests (no ClickHouse dependency)
// ---------------------------------------------------------------------------

class InMemoryUserStore implements UserStore {
  private users = new Map<string, DashboardUser>()

  async findByUsername(tenantId: string, username: string): Promise<DashboardUser | null> {
    for (const u of this.users.values()) {
      if (u.username === username && u.tenantId === tenantId) return u
    }
    return null
  }

  async findAllByUsername(username: string): Promise<DashboardUser[]> {
    return [...this.users.values()].filter((u) => u.username === username)
  }

  async findById(userId: string): Promise<DashboardUser | null> {
    return this.users.get(userId) ?? null
  }

  async listByTenant(tenantId: string): Promise<DashboardUser[]> {
    return [...this.users.values()].filter((u) => u.tenantId === tenantId)
  }

  async createUser(input: { username: string; password: string; tenantId: string; role: 'admin' | 'viewer' }): Promise<DashboardUser> {
    const userId = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const passwordHash = await hashPassword(input.password)
    const user: DashboardUser = {
      userId,
      username: input.username,
      passwordHash,
      tenantId: input.tenantId,
      role: input.role,
      mustChangePassword: true,
      totpSecret: '',
      totpEnabled: false,
      recoveryCodes: '',
      sessionVersion: 1,
      lastLoginAt: null,
    }
    this.users.set(userId, user)
    return user
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId)
    if (user) {
      user.passwordHash = passwordHash
      user.mustChangePassword = false
      user.sessionVersion++
    }
  }

  async updateTotp(userId: string, totpSecret: string, recoveryCodes: string, enabled: boolean): Promise<void> {
    const user = this.users.get(userId)
    if (user) {
      user.totpSecret = totpSecret
      user.totpEnabled = enabled
      user.recoveryCodes = recoveryCodes
      user.sessionVersion++
    }
  }

  async clearMustChangePassword(userId: string): Promise<void> {
    const user = this.users.get(userId)
    if (user) user.mustChangePassword = false
  }

  async bumpSessionVersion(userId: string): Promise<void> {
    const user = this.users.get(userId)
    if (user) user.sessionVersion++
  }

  async updateLastLogin(userId: string): Promise<void> {
    const user = this.users.get(userId)
    if (user) user.lastLoginAt = new Date().toISOString()
  }

  async deleteUser(userId: string): Promise<void> {
    this.users.delete(userId)
  }

  async countUsers(): Promise<number> {
    return this.users.size
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockDb: DbClient = {
  query: async () => [],
  insert: async () => {},
  command: async () => {},
  ping: async () => true,
  close: async () => {},
} as unknown as DbClient

async function createTestApp() {
  const logger = pino({ level: 'silent' })
  const userStore = new InMemoryUserStore()
  const keys = await deriveKeys('test-encryption-key-at-least-16-chars')
  const sessionProvider = new HmacSessionProvider(keys.sessionSigningKey)

  // Create a test admin user (password: "adminpassword1")
  await userStore.createUser({
    username: 'admin',
    password: 'adminpassword1',
    tenantId: 'test-tenant',
    role: 'admin',
  })
  // Clear mustChangePassword for easier testing
  const admin = await userStore.findByUsername('test-tenant', 'admin')
  if (admin) await userStore.clearMustChangePassword(admin.userId)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(
    '/v1',
    authRoutes({
      userStore,
      sessionProvider,
      db: mockDb,
      logger,
      totpEncryptionKey: keys.totpEncryptionKey,
      isProduction: false,
    }),
  )
  app.use(createErrorHandler(logger))
  return { app, userStore, sessionProvider, keys }
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('my-secure-password')
    assert.ok(hash.includes(':'), 'hash format is salt:hash')
    assert.ok(await verifyPassword('my-secure-password', hash))
  })

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct-password')
    assert.equal(await verifyPassword('wrong-password', hash), false)
  })

  it('rejects malformed hash', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-valid-hash'), false)
  })
})

describe('password policy', () => {
  it('rejects passwords under 12 characters', () => {
    assert.ok(validatePasswordPolicy('short'))
  })

  it('accepts passwords of 12+ characters', () => {
    assert.equal(validatePasswordPolicy('exactly12chars'), null)
  })
})

// ---------------------------------------------------------------------------
// Session provider
// ---------------------------------------------------------------------------

describe('HmacSessionProvider', () => {
  it('creates and validates a session', async () => {
    const keys = await deriveKeys('test-key-at-least-16-chars')
    const provider = new HmacSessionProvider(keys.sessionSigningKey)

    const cookie = provider.createSession({
      userId: 'u1',
      tenantId: 't1',
      role: 'admin',
      sessionVersion: 1,
    })

    const session = provider.validateSession(cookie)
    assert.ok(session)
    assert.equal(session.userId, 'u1')
    assert.equal(session.tenantId, 't1')
    assert.equal(session.role, 'admin')
  })

  it('rejects tampered cookie', async () => {
    const keys = await deriveKeys('test-key-at-least-16-chars')
    const provider = new HmacSessionProvider(keys.sessionSigningKey)
    const cookie = provider.createSession({ userId: 'u1', tenantId: 't1', role: 'admin', sessionVersion: 1 })

    const tampered = `x${cookie.slice(1)}`
    assert.equal(provider.validateSession(tampered), null)
  })

  it('rejects cookie signed with different key', async () => {
    const keys1 = await deriveKeys('key-one-at-least-16')
    const keys2 = await deriveKeys('key-two-at-least-16')
    const provider1 = new HmacSessionProvider(keys1.sessionSigningKey)
    const provider2 = new HmacSessionProvider(keys2.sessionSigningKey)

    const cookie = provider1.createSession({ userId: 'u1', tenantId: 't1', role: 'admin', sessionVersion: 1 })
    assert.equal(provider2.validateSession(cookie), null)
  })

  it('rejects empty string', async () => {
    const keys = await deriveKeys('test-key-at-least-16-chars')
    const provider = new HmacSessionProvider(keys.sessionSigningKey)
    assert.equal(provider.validateSession(''), null)
  })
})

// ---------------------------------------------------------------------------
// Lockout tracker
// ---------------------------------------------------------------------------

describe('LockoutTracker', () => {
  const ip = '10.0.0.1'

  it('is not locked initially', () => {
    const tracker = new LockoutTracker()
    assert.equal(tracker.isLocked('alice', ip), false)
  })

  it('locks after 5 failures', () => {
    const tracker = new LockoutTracker()
    for (let i = 0; i < 5; i++) tracker.recordFailure('alice', ip)
    assert.equal(tracker.isLocked('alice', ip), true)
  })

  it('clears on success', () => {
    const tracker = new LockoutTracker()
    for (let i = 0; i < 4; i++) tracker.recordFailure('alice', ip)
    tracker.recordSuccess('alice', ip)
    assert.equal(tracker.isLocked('alice', ip), false)
  })

  it('locks after 3 TOTP failures', () => {
    const tracker = new LockoutTracker()
    for (let i = 0; i < 3; i++) tracker.recordFailure('alice', ip, true)
    assert.equal(tracker.isLocked('alice', ip), true)
  })

  // Bug #166 regression: lockouts must not bleed across IPs.
  it('lockout for one IP does not affect another IP', () => {
    const tracker = new LockoutTracker()
    const attackerIp = '203.0.113.1'
    const victimIp = '198.51.100.1'
    for (let i = 0; i < 5; i++) tracker.recordFailure('alice', attackerIp)
    assert.equal(tracker.isLocked('alice', attackerIp), true)
    assert.equal(tracker.isLocked('alice', victimIp), false)
  })
})

// ---------------------------------------------------------------------------
// HKDF key derivation
// ---------------------------------------------------------------------------

describe('deriveKeys', () => {
  it('produces distinct keys for different purposes', async () => {
    const keys = await deriveKeys('test-encryption-key-at-least-16-chars')
    assert.notDeepEqual(keys.sessionSigningKey, keys.totpEncryptionKey)
    assert.notDeepEqual(keys.sessionSigningKey, keys.csrfTokenKey)
    assert.notDeepEqual(keys.totpEncryptionKey, keys.csrfTokenKey)
  })

  it('produces same keys for same input', async () => {
    const keys1 = await deriveKeys('same-key-at-least-16')
    const keys2 = await deriveKeys('same-key-at-least-16')
    assert.deepEqual(keys1.sessionSigningKey, keys2.sessionSigningKey)
  })
})

// ---------------------------------------------------------------------------
// POST /v1/auth/session — login
// ---------------------------------------------------------------------------

describe('POST /v1/auth/session', () => {
  it('returns user info and sets cookie on valid login', async () => {
    const { app } = await createTestApp()
    const res = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.username, 'admin')
    assert.equal(res.body.data.tenantId, 'test-tenant')
    assert.equal(res.body.data.role, 'admin')

    const cookies = res.headers['set-cookie']
    assert.ok(cookies)
    const cookieStr = Array.isArray(cookies) ? cookies[0] : cookies
    assert.ok(cookieStr.includes('logweave_session'))
    assert.ok(cookieStr.includes('HttpOnly'))
  })

  it('returns 401 for wrong password (generic error)', async () => {
    const { app } = await createTestApp()
    const res = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'wrongpassword1' })

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS')
  })

  it('returns 401 for nonexistent user (same error, no enumeration)', async () => {
    const { app } = await createTestApp()
    const res = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'nobody', password: 'doesntmatter1' })

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS')
  })

  // Bug #166 regression: when the same username exists in multiple tenants,
  // login must reject ambiguously rather than silently picking one tenant.
  it('rejects login when username exists in multiple tenants', async () => {
    const { app, userStore } = await createTestApp()
    // 'admin' already exists in test-tenant; create a colliding admin in another tenant
    await userStore.createUser({
      username: 'admin',
      password: 'otherpassword12',
      tenantId: 'other-tenant',
      role: 'admin',
    })

    // Even with the correct password for one of the tenants, login must fail
    const res = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })

    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS')
  })
})

// ---------------------------------------------------------------------------
// GET /v1/auth/me — session check
// ---------------------------------------------------------------------------

describe('GET /v1/auth/me', () => {
  it('returns user info with valid session cookie', async () => {
    const { app } = await createTestApp()

    // Login first
    const loginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })
    const cookies = loginRes.headers['set-cookie']

    const meRes = await request(app)
      .get('/v1/auth/me')
      .set('Cookie', cookies)

    assert.equal(meRes.status, 200)
    assert.equal(meRes.body.data.username, 'admin')
  })

  it('returns 401 without cookie', async () => {
    const { app } = await createTestApp()
    const res = await request(app).get('/v1/auth/me')
    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// DELETE /v1/auth/session — logout
// ---------------------------------------------------------------------------

describe('DELETE /v1/auth/session', () => {
  it('clears the session cookie', async () => {
    const { app } = await createTestApp()
    const res = await request(app).delete('/v1/auth/session')

    assert.equal(res.status, 204)
    const cookies = res.headers['set-cookie']
    assert.ok(cookies)
    const cookieStr = Array.isArray(cookies) ? cookies[0] : cookies
    assert.ok(cookieStr.includes('logweave_session=;'))
  })
})

// ---------------------------------------------------------------------------
// PUT /v1/auth/password — change password
// ---------------------------------------------------------------------------

describe('PUT /v1/auth/password', () => {
  it('changes password and issues new session', async () => {
    const { app } = await createTestApp()

    const loginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })
    const cookies = loginRes.headers['set-cookie']

    const changeRes = await request(app)
      .put('/v1/auth/password')
      .set('Cookie', cookies)
      .send({ currentPassword: 'adminpassword1', newPassword: 'newpassword12345' })

    assert.equal(changeRes.status, 200)
    assert.equal(changeRes.body.data.changed, true)

    // Can login with new password
    const reloginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'newpassword12345' })
    assert.equal(reloginRes.status, 200)
  })

  it('rejects short passwords', async () => {
    const { app } = await createTestApp()
    const loginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })

    const res = await request(app)
      .put('/v1/auth/password')
      .set('Cookie', loginRes.headers['set-cookie'])
      .send({ currentPassword: 'adminpassword1', newPassword: 'short' })

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'WEAK_PASSWORD')
  })
})

// ---------------------------------------------------------------------------
// Admin user management
// ---------------------------------------------------------------------------

describe('admin user management', () => {
  it('admin can create a user in own tenant', async () => {
    const { app } = await createTestApp()
    const loginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })
    const cookies = loginRes.headers['set-cookie']

    const createRes = await request(app)
      .post('/v1/auth/users')
      .set('Cookie', cookies)
      .send({ username: 'bob', password: 'bobpassword1234', tenantId: 'test-tenant', role: 'viewer' })

    assert.equal(createRes.status, 201)
    assert.equal(createRes.body.data.username, 'bob')
  })

  it('admin cannot create user in different tenant', async () => {
    const { app } = await createTestApp()
    const loginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })

    const res = await request(app)
      .post('/v1/auth/users')
      .set('Cookie', loginRes.headers['set-cookie'])
      .send({ username: 'bob', password: 'bobpassword1234', tenantId: 'other-tenant', role: 'viewer' })

    assert.equal(res.status, 403)
  })

  it('lists users in own tenant', async () => {
    const { app } = await createTestApp()
    const loginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })

    const res = await request(app)
      .get('/v1/auth/users')
      .set('Cookie', loginRes.headers['set-cookie'])

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.data))
    assert.equal(res.body.data.length, 1) // just admin
  })

  it('cannot delete self', async () => {
    const { app } = await createTestApp()
    const loginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })
    const cookies = loginRes.headers['set-cookie']
    const userId = loginRes.body.data.userId

    const res = await request(app)
      .delete(`/v1/auth/users/${userId}`)
      .set('Cookie', cookies)

    assert.equal(res.status, 400)
  })
})

// ---------------------------------------------------------------------------
// Session invalidation after password change
// ---------------------------------------------------------------------------

describe('session invalidation', () => {
  it('old session rejected after password change (sessionVersion mismatch)', async () => {
    const { app } = await createTestApp()

    const loginRes = await request(app)
      .post('/v1/auth/session')
      .send({ username: 'admin', password: 'adminpassword1' })
    const oldCookies = loginRes.headers['set-cookie']

    // Change password (bumps sessionVersion)
    await request(app)
      .put('/v1/auth/password')
      .set('Cookie', oldCookies)
      .send({ currentPassword: 'adminpassword1', newPassword: 'newpassword12345' })

    // Old cookie should be rejected (sessionVersion mismatch)
    const meRes = await request(app)
      .get('/v1/auth/me')
      .set('Cookie', oldCookies)

    assert.equal(meRes.status, 401)
  })
})
