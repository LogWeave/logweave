/**
 * S3 adapter integration test against Floci (a fast AWS emulator).
 *
 * Boot Floci before running:
 *   docker run -d --rm --name floci -p 4566:4566 floci/floci:latest
 *
 * What this locks down:
 *   - End-to-end wiring from `S3Adapter.testConnection` and `fetchRawLogs`
 *     through `STSClient` → `S3Client` against real AWS-SDK error shapes
 *     (NoSuchBucket, etc).
 *   - The AssumeRole call path itself — the test creates an IAM role on
 *     Floci, then drives the adapter through the production `roleArn` +
 *     `externalId` branch with `AWS_ENDPOINT_URL_*` env vars redirecting
 *     STS/S3 to the emulator.
 *   - The endpoint/static-creds (dev) branch — separate test cases.
 *
 * What this does NOT lock down (limitation of free AWS emulators; see
 * #209 discussion notes and `docs/connectors/s3-iam-setup.md`):
 *   - `sts:ExternalId` trust-condition enforcement. Floci and LocalStack
 *     Community accept any ExternalId. Real AWS evaluates the trust
 *     policy in production. The error-mapping behaviour for a real
 *     `AccessDenied` response is covered by the unit tests in
 *     `tests/connectors/s3-sts-errors.test.ts`.
 *
 * Suite auto-skips if Floci is not reachable on FLOCI_ENDPOINT (default
 * http://localhost:4566). CI provides the service container; local runs
 * without docker fall through to skipped.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam'
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { S3Adapter } from '../../src/connectors/s3-adapter.js'
import type { S3ConnectorConfig } from '../../src/connectors/types.js'

const FLOCI_ENDPOINT = process.env.FLOCI_ENDPOINT ?? 'http://localhost:4566'
const REGION = 'us-east-1'
const STATIC_CREDS = { accessKeyId: 'test', secretAccessKey: 'test' }
// Unique bucket per run: re-running the test against a long-lived Floci
// container otherwise leaves yesterday's fixture lying around and can mask
// a silently-failing PutObject (our assertions are >=, not ==).
const BUCKET = `logweave-s3-int-${Date.now()}`
const ROLE_NAME = `LogWeaveIntegrationRole-${Date.now()}`
const EXTERNAL_ID = 'logweave-integration-external-id'
// HMAC-secret arg the scorer requires; arbitrary value for the test.
const SESSION_SECRET = 'integration-test-secret'

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
  let iam: IAMClient | undefined
  let roleArn: string | undefined
  let flociUp = false

  before(async () => {
    flociUp = await isFlociUp()
    if (!flociUp) return

    // The adapter now SSRF-guards tenant-endpoint DNS at connect time (#286); the
    // dev/Floci endpoint resolves to an internal IP, so allow its host (mirrors
    // LOGWEAVE_CONNECTOR_ALLOWED_HOSTS in the dev compose) or the guard blocks it.
    process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS = new URL(FLOCI_ENDPOINT).hostname

    s3 = new S3Client({
      endpoint: FLOCI_ENDPOINT,
      region: REGION,
      credentials: STATIC_CREDS,
      forcePathStyle: true,
    })
    iam = new IAMClient({
      endpoint: FLOCI_ENDPOINT,
      region: REGION,
      credentials: STATIC_CREDS,
    })

    // Bucket + fixture object
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
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

    // IAM role with an ExternalId trust condition + permissive S3 inline policy.
    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: 'arn:aws:iam::000000000000:root' },
          Action: 'sts:AssumeRole',
          Condition: { StringEquals: { 'sts:ExternalId': EXTERNAL_ID } },
        },
      ],
    }
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      }),
    )
    roleArn = created.Role?.Arn
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyName: 'AllowS3',
        PolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
        }),
      }),
    )

    // Route the SDK's default STS/S3 endpoints to Floci so the adapter's
    // AssumeRole branch — which constructs unconfigured STS/S3 clients —
    // hits the emulator. AWS SDK v3 honours these env vars; verified.
    process.env.AWS_ENDPOINT_URL_STS = FLOCI_ENDPOINT
    process.env.AWS_ENDPOINT_URL_S3 = FLOCI_ENDPOINT
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'
    // Path-style for the AssumeRole tests is set on the config itself
    // (`forcePathStyle: true`) — the adapter honours it on the prod
    // branch so the S3Client uses bucket-in-path URLs instead of
    // virtual-hosted (bucket.s3.amazonaws.com → bucket.localhost, which
    // doesn't resolve). Real AWS deployments don't set it; safe no-op.
  })

  after(() => {
    s3?.destroy()
    iam?.destroy()
    delete process.env.AWS_ENDPOINT_URL_STS
    delete process.env.AWS_ENDPOINT_URL_S3
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    delete process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS
  })

  // node:test's t.skip() marks the test as skipped but does NOT abort the
  // function body — execution continues. Return a boolean so callers can early-return.
  function skipIfDown(t: { skip: (msg: string) => void }): boolean {
    if (!flociUp) {
      t.skip(`Floci not reachable at ${FLOCI_ENDPOINT}`)
      return true
    }
    return false
  }

  // --- Dev branch: static creds against `endpoint` ---

  const devConfig: S3ConnectorConfig = {
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

  it('dev branch: testConnection succeeds against a populated bucket', async (t) => {
    if (skipIfDown(t)) return
    const result = await adapter.testConnection(devConfig)
    assert.equal(result.success, true, `testConnection should succeed, got: ${result.message}`)
    assert.ok((result.filesFound ?? 0) >= 1, `expected files found, got ${result.filesFound}`)
  })

  it('dev branch: NoSuchBucket → actionable, scrubbed message', async (t) => {
    if (skipIfDown(t)) return
    const result = await adapter.testConnection({
      ...devConfig,
      bucket: 'definitely-does-not-exist-xyz-12345',
    })
    assert.equal(result.success, false)
    assert.match(result.message, /does not exist|not accessible/i)
    assert.doesNotMatch(result.message, /\barn:aws/i)
  })

  it('dev branch: fetchRawLogs returns lines matching the template', async (t) => {
    if (skipIfDown(t)) return
    const now = new Date()
    const result = await adapter.fetchRawLogs({
      config: devConfig,
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

  it('dev branch: fetchRawLogs returns 0 lines when prefix path has no objects', async (t) => {
    if (skipIfDown(t)) return
    const now = new Date()
    const result = await adapter.fetchRawLogs({
      config: { ...devConfig, prefix: 'no-such-prefix/' },
      templateText: 'connection timeout to <*>',
      service: 'web',
      timeRange: { start: new Date(now.getTime() - 3600_000), end: now },
      limit: 10,
    })
    assert.equal(result.lines.length, 0)
  })

  // --- Production branch: AssumeRole via STS ---

  it('AssumeRole branch: testConnection succeeds through STS → S3', async (t) => {
    if (skipIfDown(t)) return
    assert.ok(roleArn, 'role must have been created in before()')
    const result = await adapter.testConnection(
      {
        type: 's3',
        bucket: BUCKET,
        prefix: 'logs/',
        pathPattern: '{prefix}{service}/{year}/{month}/{day}/{hour}/',
        region: REGION,
        logFormat: 'jsonl',
        compression: 'none',
        roleArn,
        externalId: EXTERNAL_ID,
        // Required for the AssumeRole tests against Floci: the SDK
        // otherwise builds virtual-hosted URLs (bucket.s3.amazonaws.com)
        // which DNS can't resolve locally. Real AWS deployments wouldn't
        // set this; the adapter honours it when present.
        forcePathStyle: true,
      },
      {
        tenantId: 'integration-tenant',
        connectorId: 'integration-connector',
        sessionNameSecret: SESSION_SECRET,
      },
    )
    assert.equal(
      result.success,
      true,
      `AssumeRole testConnection should succeed, got: ${result.message}`,
    )
  })

  it('AssumeRole branch: fetchRawLogs returns lines after STS handshake', async (t) => {
    if (skipIfDown(t)) return
    assert.ok(roleArn, 'role must have been created in before()')
    const now = new Date()
    const result = await adapter.fetchRawLogs({
      config: {
        type: 's3',
        bucket: BUCKET,
        prefix: 'logs/',
        pathPattern: '{prefix}{service}/{year}/{month}/{day}/{hour}/',
        region: REGION,
        logFormat: 'jsonl',
        compression: 'none',
        roleArn,
        externalId: EXTERNAL_ID,
        // Required for the AssumeRole tests against Floci: the SDK
        // otherwise builds virtual-hosted URLs (bucket.s3.amazonaws.com)
        // which DNS can't resolve locally. Real AWS deployments wouldn't
        // set this; the adapter honours it when present.
        forcePathStyle: true,
      },
      templateText: 'connection timeout to <*>',
      service: 'web',
      timeRange: { start: new Date(now.getTime() - 3600_000), end: now },
      limit: 10,
      auditContext: {
        tenantId: 'integration-tenant',
        connectorId: 'integration-connector',
        sessionNameSecret: SESSION_SECRET,
      },
    })
    assert.ok(
      result.lines.length >= 2,
      `expected >=2 matches via AssumeRole, got ${result.lines.length}`,
    )
  })
})
