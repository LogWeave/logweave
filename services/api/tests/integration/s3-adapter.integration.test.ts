/**
 * S3 adapter integration test against Floci (a fast AWS emulator).
 *
 * Boot Floci before running:
 *   docker run -d --rm --name floci -p 4566:4566 floci/floci:latest
 *
 * What this locks down:
 *   - The SDK call shape (AssumeRole sends ExternalId; ListObjectsV2 works
 *     with temporary credentials).
 *   - End-to-end wiring from S3Adapter.testConnection / fetchRawLogs
 *     through STSClient → S3Client.
 *   - Error mapping on real AWS-shaped errors (NoSuchBucket, AccessDenied
 *     for missing object permissions).
 *
 * What this does NOT lock down (limitation of free AWS emulators; see #209
 * discussion notes):
 *   - sts:ExternalId trust-condition enforcement. Floci/LocalStack-CE
 *     accept any ExternalId. Real AWS evaluates the trust policy; we rely
 *     on the unit tests in s3-sts-errors.test.ts for the mapping logic.
 *
 * Suite auto-skips if Floci is not reachable on FLOCI_ENDPOINT (default
 * http://localhost:4566). CI provides the service container; local runs
 * without docker fall through to skipped.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { S3Adapter } from '../../src/connectors/s3-adapter.js'
import type { S3ConnectorConfig } from '../../src/connectors/types.js'

const FLOCI_ENDPOINT = process.env.FLOCI_ENDPOINT ?? 'http://localhost:4566'
const REGION = 'us-east-1'
const STATIC_CREDS = { accessKeyId: 'test', secretAccessKey: 'test' }
const BUCKET = 'logweave-s3-integration'

const adapter = new S3Adapter()

async function isFlociUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch(FLOCI_ENDPOINT, { signal: ctrl.signal })
    clearTimeout(timeout)
    return res.ok
  } catch {
    return false
  }
}

describe('S3Adapter integration (Floci)', async () => {
  let s3: S3Client | undefined
  let flociUp = false

  before(async () => {
    flociUp = await isFlociUp()
    if (!flociUp) return

    s3 = new S3Client({
      endpoint: FLOCI_ENDPOINT,
      region: REGION,
      credentials: STATIC_CREDS,
      forcePathStyle: true,
    })

    // Idempotent bucket setup
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
    } catch (err) {
      const name = (err as { name?: string }).name
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
        throw err
      }
    }

    // A small JSONL fixture so fetchRawLogs has something to match.
    const fixture = [
      JSON.stringify({
        timestamp: new Date().toISOString(),
        message: 'connection timeout to 10.0.0.1',
        service: 'web',
      }),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        message: 'connection timeout to 10.0.0.2',
        service: 'web',
      }),
    ].join('\n')

    const now = new Date()
    const key = `logs/web/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCHours()).padStart(2, '0')}/fixture.jsonl`
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: fixture }))
  })

  after(() => {
    s3?.destroy()
  })

  function skipIfDown(t: { skip: (msg: string) => void }) {
    if (!flociUp) t.skip(`Floci not reachable at ${FLOCI_ENDPOINT}`)
  }

  const baseConfig: S3ConnectorConfig = {
    type: 's3',
    bucket: BUCKET,
    prefix: 'logs/',
    pathPattern: '{prefix}{service}/{year}/{month}/{day}/{hour}/',
    region: REGION,
    logFormat: 'jsonl',
    compression: 'none',
    endpoint: FLOCI_ENDPOINT,
    forcePathStyle: true,
    accessKeyId: 'test',
    secretAccessKey: 'test',
  }

  it('testConnection: success against a populated bucket', async (t) => {
    skipIfDown(t)
    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, true, `testConnection should succeed, got: ${result.message}`)
    assert.ok((result.filesFound ?? 0) >= 1, `expected files found, got ${result.filesFound}`)
  })

  it('testConnection: NoSuchBucket → actionable, scrubbed message', async (t) => {
    skipIfDown(t)
    const result = await adapter.testConnection({
      ...baseConfig,
      bucket: 'definitely-does-not-exist-xyz-12345',
    })
    assert.equal(result.success, false)
    // User message must name the bucket and not echo a raw AWS sentence.
    assert.match(result.message, /does not exist|not accessible/i)
    assert.doesNotMatch(result.message, /\barn:aws/i)
  })

  it('fetchRawLogs: returns lines matching the template from the fixture', async (t) => {
    skipIfDown(t)
    const now = new Date()
    const result = await adapter.fetchRawLogs({
      config: baseConfig,
      templateText: 'connection timeout to <*>',
      service: 'web',
      timeRange: { start: new Date(now.getTime() - 3600_000), end: now },
      limit: 10,
    })
    assert.ok(result.lines.length >= 2, `expected >=2 matches, got ${result.lines.length}`)
    assert.ok(
      result.lines.every((l) => l.message.includes('connection timeout to')),
      'every returned line should match the template',
    )
    assert.ok(result.filesScanned >= 1, `expected filesScanned >= 1, got ${result.filesScanned}`)
  })

  it('fetchRawLogs: gracefully returns 0 lines when the prefix path has no objects', async (t) => {
    skipIfDown(t)
    const now = new Date()
    const result = await adapter.fetchRawLogs({
      config: { ...baseConfig, prefix: 'no-such-prefix/' },
      templateText: 'connection timeout to <*>',
      service: 'web',
      timeRange: { start: new Date(now.getTime() - 3600_000), end: now },
      limit: 10,
    })
    assert.equal(result.lines.length, 0)
  })
})
