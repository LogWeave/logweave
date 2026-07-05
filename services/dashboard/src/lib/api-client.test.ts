import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// csrfHeader reads config.apiKey to decide whether CSRF applies; mock it so we
// can flip between Bearer and cookie-session mode.
vi.mock('../config', () => ({
  config: {
    apiKey: '',
    apiUrl: '',
    fetchTimeoutMs: 10_000,
    pollIntervalMs: 60_000,
    staleTimeMs: 30_000,
  },
}))

import { config } from '../config'
import { apiErrorMessage, csrfHeader, parseCsrfToken } from './api-client'

const mutableConfig = config as { apiKey: string }

describe('parseCsrfToken', () => {
  it('returns the token half of a signed token.signature cookie', () => {
    expect(parseCsrfToken('logweave_csrf=tok123.sigABC')).toBe('tok123')
  })

  it('finds the cookie among others', () => {
    expect(parseCsrfToken('foo=1; logweave_csrf=tok.sig; bar=2')).toBe('tok')
  })

  it('URL-decodes the value before splitting', () => {
    expect(parseCsrfToken('logweave_csrf=ab%2Bc.sig')).toBe('ab+c')
  })

  it('returns undefined when the cookie is absent', () => {
    expect(parseCsrfToken('other=x; another=y')).toBeUndefined()
    expect(parseCsrfToken('')).toBeUndefined()
  })

  it('returns undefined when the value has no signature separator', () => {
    // A token with no "." is not a valid double-submit value — refuse it.
    expect(parseCsrfToken('logweave_csrf=nodothere')).toBeUndefined()
  })

  it('returns undefined when the token half is empty (leading dot)', () => {
    expect(parseCsrfToken('logweave_csrf=.sigonly')).toBeUndefined()
  })

  it('returns undefined for an empty cookie value', () => {
    expect(parseCsrfToken('logweave_csrf=')).toBeUndefined()
  })
})

describe('apiErrorMessage', () => {
  it('maps 401 to the sign-in prompt regardless of verb or body', () => {
    // Previously only GET did this; POST/PUT/DELETE leaked a raw "Unauthorized".
    expect(apiErrorMessage(401, 'Unauthorized', {})).toBe(
      'Authentication failed — please sign in again.',
    )
    expect(apiErrorMessage(401, 'Unauthorized', { error: { message: 'no session' } })).toBe(
      'Authentication failed — please sign in again.',
    )
  })

  it('prefers the structured server error message for non-401 errors', () => {
    expect(
      apiErrorMessage(422, 'Unprocessable Entity', { error: { message: 'bucket required' } }),
    ).toBe('bucket required')
  })

  it('falls back to the HTTP status text when there is no structured message', () => {
    expect(apiErrorMessage(500, 'Internal Server Error', {})).toBe('Internal Server Error')
    expect(apiErrorMessage(500, 'Internal Server Error', null)).toBe('Internal Server Error')
    expect(apiErrorMessage(404, 'Not Found', undefined)).toBe('Not Found')
  })
})

describe('csrfHeader', () => {
  function stubCookie(value: string) {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(value)
  }

  beforeEach(() => {
    mutableConfig.apiKey = ''
    stubCookie('')
  })

  afterEach(() => {
    mutableConfig.apiKey = ''
    vi.restoreAllMocks()
  })

  it('sends no CSRF header under Bearer auth, even if a cookie is present', () => {
    mutableConfig.apiKey = 'lw_dev_key'
    stubCookie('logweave_csrf=tok.sig')
    expect(csrfHeader()).toEqual({})
  })

  it('sends the CSRF header in cookie-session mode when the token is present', () => {
    stubCookie('logweave_csrf=tok.sig')
    expect(csrfHeader()).toEqual({ 'X-CSRF-Token': 'tok' })
  })

  it('sends no header in cookie-session mode when there is no token cookie yet', () => {
    expect(csrfHeader()).toEqual({})
  })
})
