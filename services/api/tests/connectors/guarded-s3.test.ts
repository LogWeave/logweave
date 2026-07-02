import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { guardedS3RequestHandler } from '../../src/connectors/guarded-s3.js'

/**
 * #286: the AWS SDK does its own DNS and bypasses safeFetch, so a tenant S3
 * connector `endpoint` whose hostname resolves to an internal IP would reach the
 * SDK. guardedS3RequestHandler wires the same resolve-time guard as safeFetch
 * into the SDK's socket connect. `localhost` → 127.0.0.1 is internal, so it's a
 * deterministic stand-in for a rebinding endpoint (no network/server needed —
 * the guard fires at connect, before any bytes are sent).
 */
describe('guardedS3RequestHandler (#286)', () => {
  // A port with nothing listening; only the ALLOWLISTED case reaches connect.
  const endpoint = 'http://localhost:59321'

  function client(allowedHosts: Set<string>): S3Client {
    return new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      // No SDK retries — a single connect attempt keeps the test fast and its
      // rejection reason unambiguous.
      maxAttempts: 1,
      requestHandler: guardedS3RequestHandler(allowedHosts),
    })
  }

  it('refuses an endpoint that resolves to an internal IP at connect time', async () => {
    await assert.rejects(
      client(new Set()).send(new ListObjectsV2Command({ Bucket: 'b' })),
      (err: unknown) => /internal address|Refusing to connect/i.test(String(err)),
      'expected the SSRF guard to reject the internal-resolving endpoint',
    )
  })

  it('allows the endpoint when its host is explicitly allowlisted', async () => {
    // Allowlisted → the guard passes the lookup; the send still fails, but only
    // because nothing is listening (ECONNREFUSED) — NOT with an SSRF error. That
    // distinction proves the guard let the connection through.
    await assert.rejects(
      client(new Set(['localhost'])).send(new ListObjectsV2Command({ Bucket: 'b' })),
      (err: unknown) => !/internal address|Refusing to connect/i.test(String(err)),
      'an allowlisted host must not be blocked by the SSRF guard',
    )
  })
})
