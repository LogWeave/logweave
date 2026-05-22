import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildQuickCreateUrl, generateExternalId } from '../../src/connectors/s3-cfn-url.js'

const TEMPLATE_URL = 'https://example.com/cfn/s3-connector-role.yaml'
const ACCOUNT_ID = '123456789012'

function quickCreateParams(url: string): URLSearchParams {
  const hashIdx = url.indexOf('#')
  const hash = hashIdx >= 0 ? url.slice(hashIdx + 1) : ''
  const qIdx = hash.indexOf('?')
  return new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : '')
}

describe('generateExternalId', () => {
  it('returns a URL-safe string of at least 32 chars', () => {
    const id = generateExternalId()
    assert.ok(id.length >= 32, `expected length >= 32, got ${id.length}`)
    assert.match(id, /^[A-Za-z0-9_-]+$/)
  })

  it('returns a different value each call', () => {
    const a = generateExternalId()
    const b = generateExternalId()
    assert.notStrictEqual(a, b)
  })
})

describe('buildQuickCreateUrl', () => {
  const baseInput = {
    logweaveAccountId: ACCOUNT_ID,
    templateUrl: TEMPLATE_URL,
    bucket: 'my-log-bucket',
    prefix: 'logs/',
    externalId: 'external-id-of-sufficient-length',
    region: 'us-east-1',
  }

  it('produces a CloudFormation quickcreate URL pointing at the right region', () => {
    const url = buildQuickCreateUrl(baseInput)
    assert.match(url, /^https:\/\/us-east-1\.console\.aws\.amazon\.com\/cloudformation\/home/)
    assert.match(url, /#\/stacks\/quickcreate\?/)
  })

  it('pre-fills all required parameters', () => {
    const url = buildQuickCreateUrl(baseInput)
    const query = quickCreateParams(url)
    assert.strictEqual(query.get('templateURL'), TEMPLATE_URL)
    assert.strictEqual(query.get('param_LogWeaveAccountId'), ACCOUNT_ID)
    assert.strictEqual(query.get('param_BucketName'), 'my-log-bucket')
    assert.strictEqual(query.get('param_BucketPrefix'), 'logs/')
    assert.strictEqual(query.get('param_ExternalId'), 'external-id-of-sufficient-length')
    assert.ok(query.get('stackName'))
  })

  it('defaults prefix to empty string when omitted', () => {
    const { prefix, ...rest } = baseInput
    void prefix
    const url = buildQuickCreateUrl(rest)
    const query = quickCreateParams(url)
    assert.strictEqual(query.get('param_BucketPrefix'), '')
  })

  it('passes optional roleName and stackName through', () => {
    const url = buildQuickCreateUrl({
      ...baseInput,
      roleName: 'CustomRole',
      stackName: 'custom-stack',
    })
    const query = quickCreateParams(url)
    assert.strictEqual(query.get('param_RoleName'), 'CustomRole')
    assert.strictEqual(query.get('stackName'), 'custom-stack')
  })

  it('rejects non-12-digit account IDs', () => {
    assert.throws(
      () => buildQuickCreateUrl({ ...baseInput, logweaveAccountId: '12345' }),
      /12-digit AWS account ID/,
    )
  })

  it('rejects short externalIds', () => {
    assert.throws(
      () => buildQuickCreateUrl({ ...baseInput, externalId: 'short' }),
      /externalId must be at least 16 characters/,
    )
  })

  it('uses the provided region in the host', () => {
    const url = buildQuickCreateUrl({ ...baseInput, region: 'eu-west-2' })
    assert.match(url, /^https:\/\/eu-west-2\.console\.aws\.amazon\.com\//)
    const query = quickCreateParams(url)
    // region param itself is implicit in the host; verify the query is still well-formed
    assert.ok(query.get('templateURL'))
  })
})
