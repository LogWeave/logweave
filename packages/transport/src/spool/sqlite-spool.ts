/**
 * SQLite-WAL SpoolStore (#269) — the `durable: true` backend. `insert` is a
 * synchronous transaction with `journal_mode=WAL` + `synchronous=FULL`, so the
 * call returns only after the WAL commit has fsynced: an event that `log()`
 * accepted survives a crash that happens before the pump sends it.
 *
 * Uses the built-in `node:sqlite` (Node >= 22.5), loaded lazily so importing
 * this package on older Node — or using only the in-memory backend — never
 * touches it. Native-module packaging is handled separately (#272).
 */
import { createRequire } from 'node:module'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { LogEvent } from '../types.js'
import { uuidv7 } from '../uuid.js'
import type { SpooledEvent, SpoolStore } from './spool-store.js'

const require = createRequire(import.meta.url)

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync
}

interface SpoolRow {
  event_id: string
  payload: string
  enqueued_at: number
}

export interface SqliteSpoolOptions {
  /** Filesystem path to the spool database file (WAL needs a real file, not :memory:). */
  readonly path: string
}

export class SqliteSpoolStore implements SpoolStore {
  private readonly db: DatabaseSync
  private readonly insertStmt: StatementSync
  private readonly peekStmt: StatementSync
  private readonly countStmt: StatementSync

  constructor(options: SqliteSpoolOptions) {
    let sqlite: SqliteModule
    try {
      sqlite = require('node:sqlite') as SqliteModule
    } catch (err) {
      throw new Error(
        '[LogWeave] durable spool requires the built-in node:sqlite module (Node >= 22.5). ' +
          `Upgrade Node or use durable: false. (${(err as Error).message})`,
      )
    }

    this.db = new sqlite.DatabaseSync(options.path)
    // WAL + FULL: every committed write fsyncs before the call returns.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS spool (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id    TEXT NOT NULL UNIQUE,
        payload     TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL
      )`,
    )

    this.insertStmt = this.db.prepare(
      'INSERT INTO spool (event_id, payload, enqueued_at) VALUES (?, ?, ?)',
    )
    this.peekStmt = this.db.prepare(
      'SELECT event_id, payload, enqueued_at FROM spool ORDER BY seq LIMIT ?',
    )
    this.countStmt = this.db.prepare('SELECT count(*) AS c FROM spool')
  }

  insert(event: LogEvent): string {
    const eventId = uuidv7()
    const enqueuedAt = Date.now()
    // Embed event_id so the replayed line carries the same dedup key.
    const payload = JSON.stringify({ ...event, event_id: eventId })
    // Autocommit INSERT under synchronous=FULL WAL → fsync before this returns.
    this.insertStmt.run(eventId, payload, enqueuedAt)
    return eventId
  }

  peekOldest(n: number): SpooledEvent[] {
    if (n <= 0) return []
    const rows = this.peekStmt.all(n) as unknown as SpoolRow[]
    return rows.map((r) => ({
      eventId: r.event_id,
      event: JSON.parse(r.payload) as LogEvent,
      enqueuedAt: r.enqueued_at,
    }))
  }

  delete(eventIds: readonly string[]): void {
    if (eventIds.length === 0) return
    const placeholders = eventIds.map(() => '?').join(', ')
    this.db.prepare(`DELETE FROM spool WHERE event_id IN (${placeholders})`).run(...eventIds)
  }

  count(): number {
    const row = this.countStmt.get() as unknown as { c: number }
    return row.c
  }

  close(): void {
    this.db.close()
  }
}
