import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { SqliteSpoolStore } from '../../src/spool/sqlite-spool.js'
import type { LogEvent } from '../../src/types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function evt(message: string): LogEvent {
  return { timestamp: '2026-06-27T00:00:00.000Z', level: 'info', message }
}

describe('SqliteSpoolStore', () => {
  let dir: string
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'lw-spool-'))
  })
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('insert assigns a UUIDv7, embeds it, and supports peek/delete/count', () => {
    const spool = new SqliteSpoolStore({ path: join(dir, 'basic.db') })
    const a = spool.insert(evt('a'))
    const b = spool.insert(evt('b'))

    assert.match(a, UUID_RE)
    assert.notEqual(a, b)
    assert.equal(spool.count(), 2)

    const peeked = spool.peekOldest(10)
    assert.deepEqual(
      peeked.map((e) => e.event.message),
      ['a', 'b'],
    )
    assert.equal(peeked[0]?.eventId, a)
    assert.equal(peeked[0]?.event.event_id, a, 'event_id embedded in payload')

    spool.delete([a])
    assert.equal(spool.count(), 1)
    assert.equal(spool.peekOldest(10)[0]?.event.message, 'b')
    spool.close()
  })

  it('peekOldest respects the limit and enqueue order', () => {
    const spool = new SqliteSpoolStore({ path: join(dir, 'order.db') })
    for (const m of ['a', 'b', 'c', 'd']) spool.insert(evt(m))
    assert.deepEqual(
      spool.peekOldest(2).map((e) => e.event.message),
      ['a', 'b'],
    )
    spool.close()
  })

  it('persists across a clean reopen', () => {
    const path = join(dir, 'reopen.db')
    const s1 = new SqliteSpoolStore({ path })
    s1.insert(evt('survive'))
    s1.close()

    const s2 = new SqliteSpoolStore({ path })
    assert.equal(s2.count(), 1)
    assert.equal(s2.peekOldest(1)[0]?.event.message, 'survive')
    s2.close()
  })

  it('survives an abrupt crash after insert — proves fsync-before-return', () => {
    const path = join(dir, 'crash.db')
    // Child inserts then process.exit(0) with no close()/flush. If it survives,
    // the WAL commit must have fsynced during insert.
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(import.meta.dirname, 'crash-child.ts'), path, 'crash-survivor'],
      { encoding: 'utf-8' },
    )
    assert.equal(child.status, 0, `crash child failed: ${child.stderr}`)

    const spool = new SqliteSpoolStore({ path })
    assert.equal(spool.count(), 1, 'event inserted before the abrupt exit must survive')
    assert.equal(spool.peekOldest(1)[0]?.event.message, 'crash-survivor')
    spool.close()
  })
})
