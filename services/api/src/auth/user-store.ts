import { randomUUID } from 'node:crypto'
import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import { hashPassword } from './passwords.js'

export interface DashboardUser {
  userId: string
  username: string
  passwordHash: string
  tenantId: string
  role: 'admin' | 'viewer'
  mustChangePassword: boolean
  totpSecret: string
  totpEnabled: boolean
  recoveryCodes: string
  sessionVersion: number
  lastLoginAt: string | null
}

export interface UserStore {
  findByUsername(tenantId: string, username: string): Promise<DashboardUser | null>
  findAllByUsername(username: string): Promise<DashboardUser[]>
  findById(userId: string): Promise<DashboardUser | null>
  listByTenant(tenantId: string): Promise<DashboardUser[]>
  createUser(user: {
    username: string
    password: string
    tenantId: string
    role: 'admin' | 'viewer'
  }): Promise<DashboardUser>
  updatePassword(userId: string, passwordHash: string, mustChangePassword?: boolean): Promise<void>
  updateTotp(
    userId: string,
    totpSecret: string,
    recoveryCodes: string,
    enabled: boolean,
  ): Promise<void>
  clearMustChangePassword(userId: string): Promise<void>
  bumpSessionVersion(userId: string): Promise<void>
  updateLastLogin(userId: string): Promise<void>
  deleteUser(userId: string): Promise<void>
  countUsers(): Promise<number>
}

interface UserRow {
  user_id: string
  username: string
  password_hash: string
  tenant_id: string
  role: string
  must_change_password: number
  totp_secret: string
  totp_enabled: number
  recovery_codes: string
  session_version: string
  last_login_at: string | null
}

function rowToUser(row: UserRow): DashboardUser {
  return {
    userId: row.user_id,
    username: row.username,
    passwordHash: row.password_hash,
    tenantId: row.tenant_id,
    role: row.role as 'admin' | 'viewer',
    mustChangePassword: row.must_change_password === 1,
    totpSecret: row.totp_secret,
    totpEnabled: row.totp_enabled === 1,
    recoveryCodes: row.recovery_codes,
    sessionVersion: Number(row.session_version),
    lastLoginAt: row.last_login_at,
  }
}

export class ClickHouseUserStore implements UserStore {
  constructor(
    private readonly db: DbClient,
    private readonly logger: pino.Logger,
  ) {}

  async findByUsername(tenantId: string, username: string): Promise<DashboardUser | null> {
    const rows = await this.db.query<UserRow>({
      query: `SELECT * FROM logweave.dashboard_users FINAL
              WHERE tenant_id = {tenantId:String} AND username = {username:String} AND is_deleted = 0
              LIMIT 1`,
      query_params: { tenantId, username },
    })
    const first = rows[0]
    return first ? rowToUser(first) : null
  }

  async findAllByUsername(username: string): Promise<DashboardUser[]> {
    const rows = await this.db.query<UserRow>({
      query: `SELECT * FROM logweave.dashboard_users FINAL
              WHERE username = {username:String} AND is_deleted = 0
              ORDER BY tenant_id`,
      query_params: { username },
    })
    return rows.map(rowToUser)
  }

  async findById(userId: string): Promise<DashboardUser | null> {
    const rows = await this.db.query<UserRow>({
      query: `SELECT * FROM logweave.dashboard_users FINAL
              WHERE user_id = {userId:String}
                AND is_deleted = 0
              LIMIT 1`,
      query_params: { userId },
    })
    const first = rows[0]
    return first ? rowToUser(first) : null
  }

  async listByTenant(tenantId: string): Promise<DashboardUser[]> {
    const rows = await this.db.query<UserRow>({
      query: `SELECT * FROM logweave.dashboard_users FINAL
              WHERE tenant_id = {tenantId:String}
                AND is_deleted = 0
              ORDER BY username`,
      query_params: { tenantId },
    })
    return rows.map(rowToUser)
  }

  async createUser(input: {
    username: string
    password: string
    tenantId: string
    role: 'admin' | 'viewer'
  }): Promise<DashboardUser> {
    const userId = randomUUID()
    const passwordHash = await hashPassword(input.password)

    await this.db.insert({
      table: 'logweave.dashboard_users',
      values: [
        {
          user_id: userId,
          username: input.username,
          password_hash: passwordHash,
          tenant_id: input.tenantId,
          role: input.role,
          must_change_password: 1,
          totp_secret: '',
          totp_enabled: 0,
          recovery_codes: '',
          session_version: 1,
          last_login_at: null,
          version: Date.now(),
          is_deleted: 0,
        },
      ],
      format: 'JSONEachRow',
    })

    this.logger.info({ userId, username: input.username, tenantId: input.tenantId }, 'User created')

    return {
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
  }

  async updatePassword(
    userId: string,
    passwordHash: string,
    mustChangePassword = false,
  ): Promise<void> {
    const user = await this.findById(userId)
    if (!user) return
    await this.db.insert({
      table: 'logweave.dashboard_users',
      values: [
        {
          user_id: userId,
          username: user.username,
          password_hash: passwordHash,
          tenant_id: user.tenantId,
          role: user.role,
          must_change_password: mustChangePassword ? 1 : 0,
          totp_secret: user.totpSecret,
          totp_enabled: user.totpEnabled ? 1 : 0,
          recovery_codes: user.recoveryCodes,
          session_version: user.sessionVersion + 1,
          last_login_at: user.lastLoginAt,
          version: Date.now(),
          is_deleted: 0,
        },
      ],
      format: 'JSONEachRow',
    })
  }

  async updateTotp(
    userId: string,
    totpSecret: string,
    recoveryCodes: string,
    enabled: boolean,
  ): Promise<void> {
    const user = await this.findById(userId)
    if (!user) return
    await this.db.insert({
      table: 'logweave.dashboard_users',
      values: [
        {
          user_id: userId,
          username: user.username,
          password_hash: user.passwordHash,
          tenant_id: user.tenantId,
          role: user.role,
          must_change_password: user.mustChangePassword ? 1 : 0,
          totp_secret: totpSecret,
          totp_enabled: enabled ? 1 : 0,
          recovery_codes: recoveryCodes,
          session_version: user.sessionVersion + 1,
          last_login_at: user.lastLoginAt,
          version: Date.now(),
          is_deleted: 0,
        },
      ],
      format: 'JSONEachRow',
    })
  }

  async clearMustChangePassword(userId: string): Promise<void> {
    const user = await this.findById(userId)
    if (!user) return
    await this.db.insert({
      table: 'logweave.dashboard_users',
      values: [
        {
          user_id: userId,
          username: user.username,
          password_hash: user.passwordHash,
          tenant_id: user.tenantId,
          role: user.role,
          must_change_password: 0,
          totp_secret: user.totpSecret,
          totp_enabled: user.totpEnabled ? 1 : 0,
          recovery_codes: user.recoveryCodes,
          session_version: user.sessionVersion,
          last_login_at: user.lastLoginAt,
          version: Date.now(),
          is_deleted: 0,
        },
      ],
      format: 'JSONEachRow',
    })
  }

  async bumpSessionVersion(userId: string): Promise<void> {
    const user = await this.findById(userId)
    if (!user) return
    await this.db.insert({
      table: 'logweave.dashboard_users',
      values: [
        {
          user_id: userId,
          username: user.username,
          password_hash: user.passwordHash,
          tenant_id: user.tenantId,
          role: user.role,
          must_change_password: user.mustChangePassword ? 1 : 0,
          totp_secret: user.totpSecret,
          totp_enabled: user.totpEnabled ? 1 : 0,
          recovery_codes: user.recoveryCodes,
          session_version: user.sessionVersion + 1,
          last_login_at: user.lastLoginAt,
          version: Date.now(),
          is_deleted: 0,
        },
      ],
      format: 'JSONEachRow',
    })
  }

  async updateLastLogin(userId: string): Promise<void> {
    const user = await this.findById(userId)
    if (!user) return
    await this.db.insert({
      table: 'logweave.dashboard_users',
      values: [
        {
          user_id: userId,
          username: user.username,
          password_hash: user.passwordHash,
          tenant_id: user.tenantId,
          role: user.role,
          must_change_password: user.mustChangePassword ? 1 : 0,
          totp_secret: user.totpSecret,
          totp_enabled: user.totpEnabled ? 1 : 0,
          recovery_codes: user.recoveryCodes,
          session_version: user.sessionVersion,
          last_login_at: new Date().toISOString(),
          version: Date.now(),
          is_deleted: 0,
        },
      ],
      format: 'JSONEachRow',
    })
  }

  async deleteUser(userId: string): Promise<void> {
    const user = await this.findById(userId)
    if (!user) return
    await this.db.insert({
      table: 'logweave.dashboard_users',
      values: [
        {
          user_id: userId,
          username: user.username,
          password_hash: '',
          tenant_id: user.tenantId,
          role: user.role,
          must_change_password: 0,
          totp_secret: '',
          totp_enabled: 0,
          recovery_codes: '',
          session_version: user.sessionVersion + 1,
          last_login_at: user.lastLoginAt,
          version: Date.now(),
          is_deleted: 1,
        },
      ],
      format: 'JSONEachRow',
    })
    this.logger.info({ userId, username: user.username }, 'User deleted')
  }

  async countUsers(): Promise<number> {
    const rows = await this.db.query<{ count: string }>({
      query: 'SELECT count() AS count FROM logweave.dashboard_users FINAL WHERE is_deleted = 0',
    })
    return Number(rows[0]?.count ?? 0)
  }
}
