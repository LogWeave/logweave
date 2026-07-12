import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import pino from 'pino'
import {
  clearBootstrapCredentials,
  writeBootstrapCredentials,
} from '../src/auth/bootstrap-credentials.js'

const silentLogger = pino({ level: 'silent' })

describe('bootstrap-credentials', () => {
  let dataDir: string
  let originalEnv: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lw-bootstrap-creds-'))
    originalEnv = process.env.LOGWEAVE_DATA_DIR
    process.env.LOGWEAVE_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LOGWEAVE_DATA_DIR
    else process.env.LOGWEAVE_DATA_DIR = originalEnv
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('writes the credentials file with the expected contents', () => {
    writeBootstrapCredentials(
      { username: 'admin', password: 'hunter2', tenantId: 'my-org' },
      silentLogger,
    )
    const path = join(dataDir, 'bootstrap-credentials.txt')
    assert.ok(existsSync(path), 'credentials file should exist')
    const body = readFileSync(path, 'utf8')
    assert.match(body, /username: admin/)
    assert.match(body, /password: hunter2/)
    assert.match(body, /tenant:\s+my-org/)
  })

  it('creates the file with mode 0600 (owner-only readable)', () => {
    writeBootstrapCredentials(
      { username: 'admin', password: 'hunter2', tenantId: 'my-org' },
      silentLogger,
    )
    const path = join(dataDir, 'bootstrap-credentials.txt')
    const stats = statSync(path)
    // Mask off file-type bits to compare only the permission bits.
    const mode = stats.mode & 0o777
    // On Windows the perm system is reduced; assert that at least no world-read flag is set.
    // On POSIX systems the value should be exactly 0o600.
    if (process.platform === 'win32') {
      assert.ok(
        (mode & 0o077) === 0 || mode === 0o666,
        `mode looked unexpectedly permissive: ${mode.toString(8)}`,
      )
    } else {
      assert.equal(mode, 0o600, `mode should be 0600, got ${mode.toString(8)}`)
    }
  })

  it('clearBootstrapCredentials removes the file', () => {
    writeBootstrapCredentials(
      { username: 'admin', password: 'hunter2', tenantId: 'my-org' },
      silentLogger,
    )
    const path = join(dataDir, 'bootstrap-credentials.txt')
    assert.ok(existsSync(path))
    clearBootstrapCredentials(silentLogger)
    assert.ok(!existsSync(path), 'credentials file should have been removed')
  })

  it('clearBootstrapCredentials is a no-op when the file is already absent', () => {
    // Pre-flight: nothing exists
    const path = join(dataDir, 'bootstrap-credentials.txt')
    assert.ok(!existsSync(path))
    // Should not throw
    clearBootstrapCredentials(silentLogger)
    assert.ok(!existsSync(path))
  })

  it('skips writing when LOGWEAVE_DATA_DIR is unset (stderr is still the source of truth)', () => {
    delete process.env.LOGWEAVE_DATA_DIR
    writeBootstrapCredentials(
      { username: 'admin', password: 'hunter2', tenantId: 'my-org' },
      silentLogger,
    )
    // No file should appear anywhere in dataDir
    assert.ok(!existsSync(join(dataDir, 'bootstrap-credentials.txt')))
  })

  it('clear is a no-op when LOGWEAVE_DATA_DIR is unset', () => {
    delete process.env.LOGWEAVE_DATA_DIR
    // Doesn't throw, doesn't try to touch any path
    clearBootstrapCredentials(silentLogger)
  })

  it('overwrites an existing file on a fresh bootstrap (idempotent)', () => {
    const path = join(dataDir, 'bootstrap-credentials.txt')
    writeFileSync(path, 'stale content from earlier run', 'utf8')
    writeBootstrapCredentials(
      { username: 'admin', password: 'fresh-pw', tenantId: 't' },
      silentLogger,
    )
    const body = readFileSync(path, 'utf8')
    assert.ok(!body.includes('stale content'))
    assert.match(body, /password: fresh-pw/)
  })
})
