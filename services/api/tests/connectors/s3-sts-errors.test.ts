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

  // SDK contract: @aws-sdk/client-sts collapses wire codes "ExpiredToken"
  // and "ExpiredTokenException" to the modeled class name
  // ExpiredTokenException. Lock the modeled name down so the regression
  // doesn't silently route to the catch-all.
  it('ExpiredTokenException: tells user this is a server-side problem (their CFN is fine)', () => {
    const { code, message } = mapStsError('ExpiredTokenException')
    assert.equal(code, 'S3_STS_EXPIRED_TOKEN')
    assert.match(message, /server-side/i)
  })

  // SDK contract: wire code "MalformedPolicy" surfaces as the modeled class
  // name MalformedPolicyDocumentException. Earlier draft mapped the
  // wire-code suffix instead of the class name and silently fell through to
  // the catch-all — caught by adversarial review, regressed here.
  it('MalformedPolicyDocumentException: tells user to update / re-create CFN stack', () => {
    const { code, message } = mapStsError('MalformedPolicyDocumentException')
    assert.equal(code, 'S3_STS_MALFORMED_POLICY')
    assert.match(message, /trust policy|cloudformation/i)
    // Should NOT recommend a destructive "delete" as the first remediation.
    assert.doesNotMatch(message, /\bdelete the\b/i)
  })

  it('RegionDisabledException: tells user STS is disabled in the region', () => {
    const { code, message } = mapStsError('RegionDisabledException')
    assert.equal(code, 'S3_STS_REGION_DISABLED')
    assert.match(message, /region/i)
  })

  // STS emits these under load. They must NOT route to the catch-all,
  // which would tell the user to wait for CloudFormation — wrong remediation.
  it('ThrottlingException: tells user to retry shortly', () => {
    const { code, message } = mapStsError('ThrottlingException')
    assert.equal(code, 'S3_STS_THROTTLED')
    assert.match(message, /rate.?limit|throttl|wait/i)
    assert.doesNotMatch(message, /cloudformation/i)
  })

  it('Throttling (legacy SDK variant): same mapping as ThrottlingException', () => {
    const { code } = mapStsError('Throttling')
    assert.equal(code, 'S3_STS_THROTTLED')
  })

  // 200 OK with empty credentials → LogWeave server bug, not customer-fixable.
  // Must not tell the user to wait for CloudFormation.
  it('NoCredentialsReturned: dedicated server-side message, not the CFN-wait catch-all', () => {
    const { code, message } = mapStsError('NoCredentialsReturned')
    assert.equal(code, 'S3_STS_NO_CREDENTIALS')
    assert.match(message, /server-side|bug|contact/i)
    assert.doesNotMatch(message, /cloudformation/i)
  })

  it('Unknown error name: actionable fallback mentioning provisioning delay', () => {
    const { code, message } = mapStsError('SomeFutureAwsError')
    assert.equal(code, 'S3_STS_UNKNOWN')
    // The most common transient cause — CFN stack still provisioning — should be named.
    assert.match(message, /provision|cloudformation|30|wait/i)
  })

  it('Never includes raw AWS account IDs, ARNs, or request fingerprints', () => {
    // Spot-check across all branches: messages must be templated, not echoes
    // of AWS error sentences which can include sensitive identifiers.
    const names = [
      'AccessDenied',
      'InvalidClientTokenId',
      'SignatureDoesNotMatch',
      'ExpiredTokenException',
      'MalformedPolicyDocumentException',
      'RegionDisabledException',
      'ThrottlingException',
      'NoCredentialsReturned',
      'Unknown',
    ]
    for (const name of names) {
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
