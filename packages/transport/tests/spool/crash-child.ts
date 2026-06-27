/**
 * Crash fixture for the SqliteSpoolStore durability test (NOT a test file —
 * `.ts`, not `.test.ts`, so the runner skips it).
 *
 * Opens a durable spool, inserts the given messages, then exits abruptly via
 * process.exit(0) — no close(), no flush, no cleanup. If the rows survive into
 * the parent's reopen, it can only be because insert fsynced before returning.
 *
 * Usage: node --import tsx crash-child.ts <db-path> <message...>
 */
import { SqliteSpoolStore } from '../../src/spool/sqlite-spool.js'

const [dbPath, ...messages] = process.argv.slice(2)
if (!dbPath) {
  console.error('crash-child: missing db path')
  process.exit(2)
}

const spool = new SqliteSpoolStore({ path: dbPath })
for (const message of messages) {
  spool.insert({ timestamp: new Date().toISOString(), level: 'info', message })
}

// Abrupt termination: skip close() and every exit handler.
process.exit(0)
