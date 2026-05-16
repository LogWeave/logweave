import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  redactFields,
  sanitizeMessage,
  stripStackTraces,
  summarizeConfig,
} from '../src/internal-events/redaction.js'

describe('redactFields', () => {
  it('redacts universally forbidden keys regardless of event', () => {
    const out = redactFields({
      tenant_id: 't1',
      api_key: 'lw_secret_abc',
      password: 'hunter2',
      webhook_url: 'https://hooks.slack.com/services/...',
      route: '/v1/ingest',
    })
    assert.equal(out.tenant_id, 't1')
    assert.equal(out.route, '/v1/ingest')
    assert.match(String(out.api_key), /^<redacted:len=\d+>$/)
    assert.match(String(out.password), /^<redacted:len=\d+>$/)
    assert.match(String(out.webhook_url), /^<redacted:len=\d+>$/)
  })

  it('matches forbidden keys case-insensitively', () => {
    const out = redactFields({
      Authorization: 'Bearer xyz',
      ApiKey: 'lw_abc',
      SESSION_ID: 'sess',
    })
    assert.match(String(out.Authorization), /^<redacted/)
    assert.match(String(out.ApiKey), /^<redacted/)
    assert.match(String(out.SESSION_ID), /^<redacted/)
  })

  it('scrubs one level into nested objects', () => {
    const out = redactFields({
      config: { port: 3000, password: 'hunter2', clickhouse_host: 'ch' },
    })
    const nested = out.config as Record<string, unknown>
    assert.equal(nested.port, 3000)
    assert.equal(nested.clickhouse_host, 'ch')
    assert.match(String(nested.password), /^<redacted/)
  })
})

describe('summarizeConfig', () => {
  it('passes through allowlisted keys verbatim', () => {
    const out = summarizeConfig({ port: 3000, logLevel: 'info', clustererUrl: 'http://x' })
    assert.equal(out.port, 3000)
    assert.equal(out.logLevel, 'info')
    assert.equal(out.clustererUrl, 'http://x')
  })

  it('redacts non-allowlisted keys even if they look safe', () => {
    const out = summarizeConfig({
      port: 3000,
      clickhousePassword: 'hunter2',
      encryptionKey: 'aaaaaaaaaaaaaaaa',
      apiKeys: 'lots',
    })
    assert.equal(out.port, 3000)
    assert.match(String(out.clickhousePassword), /^<redacted:len=\d+>$/)
    assert.match(String(out.encryptionKey), /^<redacted:len=\d+>$/)
    assert.match(String(out.apiKeys), /^<redacted:len=\d+>$/)
  })
})

describe('stripStackTraces', () => {
  it('removes stack/stackTrace keys entirely', () => {
    const out = stripStackTraces({
      code: 'X',
      stack: 'Error\n    at foo (a.js:1:1)',
      stackTrace: 'whatever',
      stack_trace: 'whatever',
    })
    assert.equal(out.code, 'X')
    assert.equal(out.stack, undefined)
    assert.equal(out.stackTrace, undefined)
    assert.equal(out.stack_trace, undefined)
  })

  it('truncates string values that look like multi-line stack traces', () => {
    const out = stripStackTraces({
      message: 'TypeError: boom\n    at f (x.js:1:1)\n    at g (y.js:2:2)',
    })
    assert.equal(out.message, 'TypeError: boom')
  })

  it('preserves single-line strings', () => {
    const out = stripStackTraces({ message: 'something failed' })
    assert.equal(out.message, 'something failed')
  })
})

describe('sanitizeMessage', () => {
  it('redacts long opaque tokens embedded in messages', () => {
    const out = sanitizeMessage('failed: lw_abc123def456ghi789jkl012mno345')
    assert.match(out, /<redacted:token>/)
  })

  it('preserves short words', () => {
    const out = sanitizeMessage('failed to query template_id 42')
    assert.equal(out, 'failed to query template_id 42')
  })

  it('caps message length at 240 chars', () => {
    const out = sanitizeMessage('plain prose '.repeat(50))
    assert.equal(out.length, 240)
  })
})
