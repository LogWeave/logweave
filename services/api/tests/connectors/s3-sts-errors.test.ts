import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapStsError, StsAssumeRoleError } from '../../src/connectors/s3-adapter.js'

describe('mapStsError', () => {
  it('AccessDenied: actionable message about trust policy / ExternalId', () => {
    const { code, message } = mapStsError('AccessDenied')
    assert.equal(code, 'S3_ASSUME_ROLE_DENIED')
    // The whole point of this issue is to point at the most likely cause.
    assert.match(message, /trust policy/i)
    assert.match(message, /external id/i)
  })

  it('InvalidClientTokenId: surfaces as server-side config problem', () => {
    const { code, message } = mapStsError('InvalidClientTokenId')
    assert.equal(code, 'S3_STS_INVALID_CREDENTIALS')
    assert.match(message, /server-side/i)
  })

  it('SignatureDoesNotMatch: shares the InvalidClientTokenId mapping', () => {
    const { code } = mapStsError('SignatureDoesNotMatch')
    assert.equal(code, 'S3_STS_INVALID_CREDENTIALS')
  })

  it('ExpiredToken: tells user this is a server-side problem (their CFN is fine)', () => {
    const { code, message } = mapStsError('ExpiredToken')
    assert.equal(code, 'S3_STS_EXPIRED_TOKEN')
    assert.match(message, /server-side/i)
  })

  it('ExpiredTokenException: same mapping as ExpiredToken (SDK variants)', () => {
    const { code } = mapStsError('ExpiredTokenException')
    assert.equal(code, 'S3_STS_EXPIRED_TOKEN')
  })

  it('MalformedPolicyDocument: tells user to redo CFN', () => {
    const { code, message } = mapStsError('MalformedPolicyDocument')
    assert.equal(code, 'S3_STS_MALFORMED_POLICY')
    assert.match(message, /trust policy|cloudformation/i)
  })

  it('RegionDisabledException: tells user STS is disabled in the region', () => {
    const { code, message } = mapStsError('RegionDisabledException')
    assert.equal(code, 'S3_STS_REGION_DISABLED')
    assert.match(message, /region/i)
  })

  it('Unknown error name: actionable fallback mentioning provisioning delay', () => {
    const { code, message } = mapStsError('SomeFutureAwsError')
    assert.equal(code, 'S3_STS_UNKNOWN')
    // The most common transient cause — CFN stack still provisioning — should be named.
    assert.match(message, /provision|cloudformation|30|wait/i)
  })

  it('Never includes raw AWS account IDs, ARNs, or request fingerprints', () => {
    // Spot-check a few mappings: messages should be templated, not echoes
    // of AWS error sentences which can include sensitive identifiers.
    for (const name of ['AccessDenied', 'InvalidClientTokenId', 'ExpiredToken', 'Unknown']) {
      const { message } = mapStsError(name)
      assert.doesNotMatch(message, /\barn:aws/i)
      assert.doesNotMatch(message, /\b\d{12}\b/) // 12-digit AWS account IDs
      assert.doesNotMatch(message, /\brequest id\b/i)
    }
  })
})

describe('StsAssumeRoleError', () => {
  it('carries the AWS error name and original message', () => {
    const err = new StsAssumeRoleError(
      'AccessDenied',
      'User is not authorized to perform sts:AssumeRole',
    )
    assert.equal(err.errorName, 'AccessDenied')
    assert.equal(err.name, 'StsAssumeRoleError')
    assert.match(err.message, /AssumeRole/)
  })

  it('is an instanceof Error (so instanceof checks at catch sites work)', () => {
    const err = new StsAssumeRoleError('X', 'y')
    assert.ok(err instanceof Error)
    assert.ok(err instanceof StsAssumeRoleError)
  })
})
