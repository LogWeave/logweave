import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  assertBasePathAllowed,
  defaultAllowedFsRoots,
  isBasePathAllowed,
} from '../../src/connectors/fs-roots.js'

afterEach(() => {
  delete process.env.LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS
})

describe('defaultAllowedFsRoots', () => {
  it('is empty when the env var is unset (connector disabled by default)', () => {
    assert.deepEqual(defaultAllowedFsRoots(), [])
  })

  it('splits, trims, and resolves a comma-separated list', () => {
    process.env.LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS = ` /var/log , /data/logs `
    assert.deepEqual(defaultAllowedFsRoots(), [resolve('/var/log'), resolve('/data/logs')])
  })

  it('drops empty segments', () => {
    process.env.LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS = '/var/log,,'
    assert.deepEqual(defaultAllowedFsRoots(), [resolve('/var/log')])
  })
})

describe('isBasePathAllowed', () => {
  const roots = [resolve('/var/log')]

  it('allows the root itself', () => {
    assert.equal(isBasePathAllowed('/var/log', roots), true)
  })

  it('allows a nested directory', () => {
    assert.equal(isBasePathAllowed('/var/log/app', roots), true)
  })

  it('rejects a sibling that shares a prefix string', () => {
    // "/var/logsecret" starts with "/var/log" as a string but is not nested.
    assert.equal(isBasePathAllowed('/var/logsecret', roots), false)
  })

  it('rejects a path outside every root', () => {
    assert.equal(isBasePathAllowed('/etc', roots), false)
  })

  it('rejects a traversal that escapes after resolution', () => {
    assert.equal(isBasePathAllowed('/var/log/../../etc', roots), false)
  })
})

describe('assertBasePathAllowed', () => {
  it('throws when the allowlist is empty (fail closed / disabled)', () => {
    assert.throws(() => assertBasePathAllowed('/var/log', []), /disabled/)
  })

  it('throws for a path outside the roots', () => {
    assert.throws(
      () => assertBasePathAllowed('/etc', [resolve('/var/log')]),
      /outside the permitted/,
    )
  })

  it('does not throw for a permitted path', () => {
    const dir = join(tmpdir(), 'logs')
    assert.doesNotThrow(() => assertBasePathAllowed(dir, [resolve(tmpdir())]))
  })

  it('reads the allowlist from the env when roots are not passed', () => {
    process.env.LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS = resolve('/var/log')
    assert.doesNotThrow(() => assertBasePathAllowed('/var/log/app'))
    assert.throws(() => assertBasePathAllowed('/etc'))
  })
})
