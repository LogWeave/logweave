import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FilesystemAdapter, guardPath } from '../../src/connectors/filesystem-adapter.js'
import type { FetchRawLogsParams, FilesystemConnectorConfig } from '../../src/connectors/types.js'

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `logweave-fs-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  // The filesystem connector is disabled unless basePath is within a permitted
  // root; tmpdir() covers every per-test dir created above.
  process.env.LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS = tmpdir()
})

afterEach(() => {
  delete process.env.LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
})

// ---------------------------------------------------------------------------
// guardPath — path traversal prevention
// ---------------------------------------------------------------------------

describe('guardPath', () => {
  it('allows paths within basePath', () => {
    const result = guardPath('/var/logs', '/var/logs/app.log')
    assert.ok(result.includes('app.log'))
  })

  it('allows basePath itself', () => {
    const result = guardPath('/var/logs', '/var/logs')
    assert.ok(result)
  })

  it('REJECTS path traversal with ../', () => {
    assert.throws(
      () => guardPath('/var/logs', '/var/logs/../../etc/passwd'),
      /Path traversal rejected/,
    )
  })

  it('REJECTS path that resolves outside basePath', () => {
    assert.throws(() => guardPath('/var/logs', '/etc/shadow'), /Path traversal rejected/)
  })

  it('REJECTS relative traversal that escapes', () => {
    assert.throws(
      () => guardPath('/var/logs/app', '/var/logs/other/../../../etc/passwd'),
      /Path traversal rejected/,
    )
  })
})

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('FilesystemAdapter.testConnection', () => {
  const adapter = new FilesystemAdapter()

  it('returns success when directory exists and files found', () => {
    writeFileSync(join(testDir, 'app.log'), 'test log line\n')

    return adapter
      .testConnection({
        type: 'filesystem',
        basePath: testDir,
        filePattern: '*.log',
        logFormat: 'text',
      })
      .then((result) => {
        assert.equal(result.success, true)
        assert.ok(result.message.includes('1 file'))
      })
  })

  it('returns success with zero files when pattern does not match', () => {
    writeFileSync(join(testDir, 'app.txt'), 'test\n')

    return adapter
      .testConnection({
        type: 'filesystem',
        basePath: testDir,
        filePattern: '*.log',
        logFormat: 'text',
      })
      .then((result) => {
        assert.equal(result.success, true)
        assert.ok(result.message.includes('no files'))
      })
  })

  it('returns failure when directory does not exist', () => {
    return adapter
      .testConnection({
        type: 'filesystem',
        basePath: join(testDir, 'nonexistent'),
        filePattern: '*.log',
        logFormat: 'text',
      })
      .then((result) => {
        assert.equal(result.success, false)
        assert.ok(result.message.includes('does not exist'))
      })
  })

  it('returns failure when path is a file, not a directory', () => {
    const filePath = join(testDir, 'not-a-dir.log')
    writeFileSync(filePath, 'content\n')

    return adapter
      .testConnection({
        type: 'filesystem',
        basePath: filePath,
        filePattern: '*.log',
        logFormat: 'text',
      })
      .then((result) => {
        assert.equal(result.success, false)
        assert.ok(result.message.includes('not a directory'))
      })
  })
})

// ---------------------------------------------------------------------------
// fetchRawLogs
// ---------------------------------------------------------------------------

describe('FilesystemAdapter.fetchRawLogs', () => {
  const adapter = new FilesystemAdapter()

  function makeConfig(overrides?: Partial<FilesystemConnectorConfig>): FilesystemConnectorConfig {
    return {
      type: 'filesystem',
      basePath: testDir,
      filePattern: '*.log',
      logFormat: 'text',
      ...overrides,
    }
  }

  function makeParams(overrides?: Partial<FetchRawLogsParams>): FetchRawLogsParams {
    return {
      config: makeConfig(),
      templateText: 'Connection from <IP> timed out',
      service: 'payments',
      timeRange: {
        start: new Date(Date.now() - 3_600_000),
        // Add 60s buffer to handle filesystem timestamp granularity
        end: new Date(Date.now() + 60_000),
      },
      limit: 50,
      ...overrides,
    }
  }

  it('matches plain text lines in log files', async () => {
    writeFileSync(
      join(testDir, 'app.log'),
      [
        'Connection from 10.0.0.1 timed out after 5000ms',
        'User logged in',
        'Connection from 192.168.1.5 timed out after 3000ms',
      ].join('\n'),
    )

    const result = await adapter.fetchRawLogs(makeParams())
    assert.equal(result.lines.length, 2)
    assert.ok(result.lines[0]?.message.includes('10.0.0.1'))
    assert.equal(result.filesScanned, 1)
    assert.ok(result.bytesScanned > 0)
  })

  it('matches JSONL log format', async () => {
    writeFileSync(
      join(testDir, 'app.log'),
      [
        JSON.stringify({
          message: 'Connection from 10.0.0.1 timed out',
          timestamp: '2026-01-01T00:00:00Z',
        }),
        JSON.stringify({ message: 'healthy', timestamp: '2026-01-01T00:01:00Z' }),
      ].join('\n'),
    )

    const config = makeConfig({ logFormat: 'jsonl' })
    const result = await adapter.fetchRawLogs(makeParams({ config }))
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0]?.timestamp, '2026-01-01T00:00:00Z')
  })

  it('returns empty when no files match pattern', async () => {
    writeFileSync(join(testDir, 'app.txt'), 'Connection from 10.0.0.1 timed out\n')

    const result = await adapter.fetchRawLogs(makeParams())
    assert.equal(result.lines.length, 0)
    assert.equal(result.filesScanned, 0)
  })

  it('respects limit parameter', async () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `Connection from 10.0.0.${i} timed out`,
    ).join('\n')
    writeFileSync(join(testDir, 'app.log'), lines)

    const result = await adapter.fetchRawLogs(makeParams({ limit: 5 }))
    assert.equal(result.lines.length, 5)
  })

  it('scans multiple files', async () => {
    writeFileSync(join(testDir, 'a.log'), 'Connection from 10.0.0.1 timed out\n')
    writeFileSync(join(testDir, 'b.log'), 'Connection from 10.0.0.2 timed out\n')

    const result = await adapter.fetchRawLogs(makeParams())
    assert.equal(result.lines.length, 2)
    assert.equal(result.filesScanned, 2)
  })

  it('source field shows relative path', async () => {
    writeFileSync(join(testDir, 'app.log'), 'Connection from 10.0.0.1 timed out\n')

    const result = await adapter.fetchRawLogs(makeParams())
    assert.equal(result.lines[0]?.source, 'app.log')
  })

  it('does NOT return files outside the time range', async () => {
    writeFileSync(join(testDir, 'old.log'), 'Connection from 10.0.0.1 timed out\n')

    // Use a time range far in the future
    const result = await adapter.fetchRawLogs(
      makeParams({
        timeRange: {
          start: new Date('2099-01-01'),
          end: new Date('2099-01-02'),
        },
      }),
    )
    assert.equal(result.lines.length, 0)
  })
})
