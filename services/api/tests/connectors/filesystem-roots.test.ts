import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FilesystemAdapter } from '../../src/connectors/filesystem-adapter.js'
import {
  allowedFilesystemRoots,
  assertWithinAllowedRoots,
} from '../../src/connectors/filesystem-roots.js'

// The filesystem connector's guardPath only blocks traversal *outside* basePath,
// but basePath is admin-controlled and API keys are always "admin" — so without
// a server-operator root allowlist any tenant key could point basePath at "/"
// and read arbitrary files (e.g. /proc/self/environ → the encryption key). These
// tests cover the LOGWEAVE_FILESYSTEM_ROOTS allowlist: empty ⇒ disabled, and
// every path (including symlink targets) must resolve within an allowed root.

// Creating a symlink on Windows requires Developer Mode or an elevated process;
// without it symlinkSync throws EPERM. Probe the capability once and skip the two
// symlink-target tests when it's unavailable — the realpath-escape guard they
// cover always runs in CI (Linux), where symlinks are creatable.
const symlinkSupported = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), 'lw-fsprobe-'))
  try {
    const target = path.join(probe, 'target')
    writeFileSync(target, '')
    symlinkSync(target, path.join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()
const skipSymlink = symlinkSupported
  ? undefined
  : 'symlink creation not permitted on this platform (needs elevation / Developer Mode)'

let root: string
let outside: string
let prevRoots: string | undefined

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lw-fsroot-'))
  outside = mkdtempSync(path.join(tmpdir(), 'lw-fsoutside-'))
  prevRoots = process.env.LOGWEAVE_FILESYSTEM_ROOTS
})

afterEach(() => {
  if (prevRoots === undefined) delete process.env.LOGWEAVE_FILESYSTEM_ROOTS
  else process.env.LOGWEAVE_FILESYSTEM_ROOTS = prevRoots
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('assertWithinAllowedRoots', () => {
  it('rejects everything when the allowlist is empty (connector disabled)', async () => {
    delete process.env.LOGWEAVE_FILESYSTEM_ROOTS
    assert.deepEqual(allowedFilesystemRoots(), [])
    await assert.rejects(() => assertWithinAllowedRoots(root), /disabled/)
  })

  it('allows a path inside an allowed root', async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = root
    const sub = path.join(root, 'logs')
    mkdirSync(sub)
    const real = await assertWithinAllowedRoots(sub)
    assert.ok(real.length > 0)
  })

  it('allows the allowed root itself', async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = root
    assert.ok(await assertWithinAllowedRoots(root))
  })

  it('rejects a path outside every allowed root', async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = root
    await assert.rejects(() => assertWithinAllowedRoots(outside), /outside the allowed/)
  })

  it('rejects a non-existent path with a safe message', async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = root
    await assert.rejects(
      () => assertWithinAllowedRoots(path.join(root, 'nope')),
      /does not exist or is not within/,
    )
  })

  it('rejects a symlink whose TARGET escapes the allowed root', { skip: skipSymlink }, async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = root
    const secret = path.join(outside, 'secret.txt')
    writeFileSync(secret, 'top secret')
    const link = path.join(root, 'link-to-secret')
    symlinkSync(secret, link)
    // The link path is lexically under root, but realpath resolves it to `outside`.
    await assert.rejects(() => assertWithinAllowedRoots(link), /outside the allowed/)
  })

  it('supports multiple comma-separated roots', async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = `${outside}, ${root}`
    assert.equal(allowedFilesystemRoots().length, 2)
    await assert.doesNotReject(() => assertWithinAllowedRoots(root))
    await assert.doesNotReject(() => assertWithinAllowedRoots(outside))
  })
})

describe('FilesystemAdapter enforces the root allowlist at fetch time', () => {
  const adapter = new FilesystemAdapter()

  const range = () => ({
    start: new Date(Date.now() - 3_600_000),
    end: new Date(Date.now() + 60_000),
  })

  it('testConnection fails for a basePath outside the allowlist', async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = root
    const result = await adapter.testConnection({
      type: 'filesystem',
      basePath: outside,
      filePattern: '*.log',
      logFormat: 'text',
    })
    assert.equal(result.success, false)
    assert.match(result.message, /outside the allowed/)
  })

  it('fetchRawLogs throws for a basePath outside the allowlist', async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = root
    writeFileSync(path.join(outside, 'app.log'), 'Connection from 10.0.0.1 timed out\n')
    await assert.rejects(
      () =>
        adapter.fetchRawLogs({
          config: {
            type: 'filesystem',
            basePath: outside,
            filePattern: '*.log',
            logFormat: 'text',
          },
          templateText: 'Connection from <IP> timed out',
          service: 'svc',
          timeRange: range(),
          limit: 50,
        }),
      /outside the allowed/,
    )
  })

  it('does NOT surface a symlink under basePath that points outside the allowlist', { skip: skipSymlink }, async () => {
    process.env.LOGWEAVE_FILESYSTEM_ROOTS = root
    // A log file living outside the allowlist, symlinked into the allowed root.
    const secret = path.join(outside, 'secret.log')
    writeFileSync(secret, 'Connection from 10.0.0.1 timed out\n')
    symlinkSync(secret, path.join(root, 'evil.log'))

    const result = await adapter.fetchRawLogs({
      config: { type: 'filesystem', basePath: root, filePattern: '*.log', logFormat: 'text' },
      templateText: 'Connection from <IP> timed out',
      service: 'svc',
      timeRange: range(),
      limit: 50,
    })
    assert.equal(result.lines.length, 0, 'must not follow a symlink out of the allowed root')
  })
})
