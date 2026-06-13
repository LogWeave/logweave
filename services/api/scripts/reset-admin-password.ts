#!/usr/bin/env node --import tsx
/**
 * Admin password recovery — for when the admin user has forgotten their password
 * and no other admin is around to reset it via the dashboard UI.
 *
 * Usage (inside the API container, after the stack is running):
 *   docker compose -f docker-compose.prod.yml exec api node --import tsx scripts/reset-admin-password.ts [username]
 *
 * If no username is supplied, defaults to "admin".
 *
 * What it does:
 *   1. Connects to ClickHouse with the same env the API uses
 *   2. Looks up the user by username (across all tenants)
 *   3. Generates a fresh random password
 *   4. Writes the new password hash + sets must_change_password=1
 *   5. Prints the new password to stderr
 *
 * What it does NOT do:
 *   - Delete any logs, templates, rules, or other tenant data
 *   - Touch any user other than the one named
 *   - Affect tenant-isolation (the user stays in their original tenant)
 *
 * The user must change the password on next login, just like the bootstrap flow.
 */
import { randomBytes } from 'node:crypto'
import pino from 'pino'
import { ClickHouseUserStore } from '../src/auth/user-store.js'
import { createClickHouseClient } from '../src/clients/clickhouse.js'
import { loadConfig } from '../src/config.js'
import { DbClient } from '../src/db/client.js'
import { hashPassword } from '../src/auth/passwords.js'

async function main(): Promise<void> {
  const username = process.argv[2] || 'admin'
  const logger = pino({ level: 'info' })

  const config = loadConfig()
  const ch = createClickHouseClient(config)
  const db = new DbClient(ch)
  const userStore = new ClickHouseUserStore(db, logger)

  const matches = await userStore.findAllByUsername(username)
  if (matches.length === 0) {
    process.stderr.write(`\n  No user named "${username}" found.\n`)
    process.stderr.write('  Use a real username, or wipe the users table for a fresh bootstrap:\n')
    process.stderr.write('  docker compose exec clickhouse clickhouse-client --query "TRUNCATE TABLE logweave.dashboard_users"\n\n')
    process.exit(1)
  }
  if (matches.length > 1) {
    process.stderr.write(`\n  Multiple users named "${username}" exist across tenants:\n`)
    for (const u of matches) {
      process.stderr.write(`    - userId=${u.userId} tenant=${u.tenantId} role=${u.role}\n`)
    }
    process.stderr.write('  This script only resets a unique username; cannot disambiguate. Use the dashboard UI as another admin.\n\n')
    process.exit(1)
  }

  const target = matches[0]
  if (!target) {
    process.stderr.write('\n  Unexpected: match list empty after length check. Aborting.\n\n')
    process.exit(1)
  }

  const newPassword = randomBytes(18).toString('base64url')
  const newHash = await hashPassword(newPassword)
  await userStore.updatePassword(target.userId, newHash, true)

  process.stderr.write('\n')
  process.stderr.write('=================================================================\n')
  process.stderr.write('LOGWEAVE PASSWORD RESET — save this password now (shown once).\n')
  process.stderr.write(`  Username: ${target.username}\n`)
  process.stderr.write(`  Password: ${newPassword}\n`)
  process.stderr.write(`  Tenant:   ${target.tenantId}\n`)
  process.stderr.write('You will be required to change it on next login.\n')
  process.stderr.write('=================================================================\n\n')

  await ch.close()
}

main().catch((err) => {
  process.stderr.write(`\n  reset-admin-password failed: ${err instanceof Error ? err.message : String(err)}\n\n`)
  process.exit(1)
})
