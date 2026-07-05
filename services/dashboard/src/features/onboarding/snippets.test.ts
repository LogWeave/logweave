import { describe, expect, it } from 'vitest'
import {
  API_KEY_PLACEHOLDER,
  curlSnippet,
  goSnippet,
  mcpSnippet,
  nodeSnippet,
  otelSnippet,
  pythonSnippet,
} from './snippets'

const URL = 'https://logs.acme.example'
const KEY = 'lw_live_abc123'

/**
 * The snippets are the very first thing a new user copies. Two things must never
 * regress: the placeholder fallback (so an un-configured dashboard still shows a
 * runnable-looking command) and the ingest endpoint path (a wrong path silently
 * breaks every new integration).
 */

describe('placeholder fallback', () => {
  const all = [
    ['curl', curlSnippet],
    ['node', nodeSnippet],
    ['python', pythonSnippet],
    ['go', goSnippet],
    ['otel', otelSnippet],
    ['mcp', mcpSnippet],
  ] as const

  it.each(all)('%s falls back to the API key placeholder when key is empty', (_name, fn) => {
    expect(fn(URL, '')).toContain(API_KEY_PLACEHOLDER)
  })

  it.each(all)('%s falls back to localhost when the URL is empty', (_name, fn) => {
    expect(fn('', KEY)).toContain('http://localhost:3000')
  })

  it.each(all)('%s interpolates real values when provided', (_name, fn) => {
    const out = fn(URL, KEY)
    expect(out).toContain(KEY)
    expect(out).not.toContain(API_KEY_PLACEHOLDER)
  })
})

describe('ingest endpoint paths', () => {
  it.each([
    ['curl', curlSnippet],
    ['python', pythonSnippet],
    ['go', goSnippet],
  ] as const)('%s posts to the batch ingest endpoint', (_name, fn) => {
    expect(fn(URL, KEY)).toContain(`${URL}/v1/ingest/batch`)
  })

  it('otel exports to the OTLP logs endpoint, not the batch endpoint', () => {
    const out = otelSnippet(URL, KEY)
    expect(out).toContain(`${URL}/v1/logs`)
    expect(out).not.toContain('/v1/ingest/batch')
  })

  it('node transport is given the bare endpoint (the SDK appends the path)', () => {
    const out = nodeSnippet(URL, KEY)
    expect(out).toContain(`endpoint: "${URL}"`)
    expect(out).not.toContain(`${URL}/v1`)
  })

  it('mcp config exposes the URL and key as env vars', () => {
    const out = mcpSnippet(URL, KEY)
    expect(out).toContain(`"LOGWEAVE_API_URL": "${URL}"`)
    expect(out).toContain(`"LOGWEAVE_API_KEY": "${KEY}"`)
  })
})

describe('bearer auth header', () => {
  it.each([
    ['curl', curlSnippet],
    ['python', pythonSnippet],
    ['go', goSnippet],
    ['otel', otelSnippet],
  ] as const)('%s sends the key as a Bearer token', (_name, fn) => {
    expect(fn(URL, KEY)).toContain(`Bearer ${KEY}`)
  })
})
