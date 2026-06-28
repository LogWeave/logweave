import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildArchiveConfig } from '../../src/connectors/archive-config.js'

describe('buildArchiveConfig', () => {
  it('returns undefined when no archive bucket is configured', () => {
    assert.equal(buildArchiveConfig({}), undefined)
    assert.equal(buildArchiveConfig({ region: 'us-east-1' }), undefined)
  })

  it('builds a prod config that uses the default credential chain (no creds/endpoint)', () => {
    const cfg = buildArchiveConfig({ bucket: 'acme-archive', region: 'eu-west-1' })
    assert.ok(cfg)
    assert.equal(cfg.type, 's3')
    assert.equal(cfg.bucket, 'acme-archive')
    assert.equal(cfg.region, 'eu-west-1')
    assert.equal(cfg.logFormat, 'jsonl')
    assert.equal(cfg.compression, 'gzip')
    // No endpoint / static creds / roleArn → S3Adapter falls through to the
    // default credential chain (the EC2 instance role).
    assert.equal(cfg.endpoint, undefined)
    assert.equal(cfg.accessKeyId, undefined)
    assert.equal(cfg.secretAccessKey, undefined)
    assert.equal(cfg.roleArn, undefined)
  })

  it('defaults region to us-east-1', () => {
    assert.equal(buildArchiveConfig({ bucket: 'b' })?.region, 'us-east-1')
  })

  it('builds a dev config with endpoint + path-style + static creds', () => {
    const cfg = buildArchiveConfig({
      bucket: 'logweave-logs',
      region: 'us-east-1',
      endpoint: 'http://floci:4566',
      accessKeyId: 'test',
      secretAccessKey: 'secret',
    })
    assert.ok(cfg)
    assert.equal(cfg.endpoint, 'http://floci:4566')
    assert.equal(cfg.forcePathStyle, true)
    assert.equal(cfg.accessKeyId, 'test')
    assert.equal(cfg.secretAccessKey, 'secret')
  })
})
