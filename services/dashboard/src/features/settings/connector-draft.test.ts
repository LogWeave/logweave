import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ConnectorDraft, clearDraft, loadDraft, saveDraft } from './connector-draft'

const STORAGE_KEY = 'logweave.connector-draft.s3'
const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('saveDraft / loadDraft round-trip', () => {
  it('restores the form values and name that were saved', () => {
    saveDraft('s3', { formValues: { bucket: 'my-logs', region: 'us-east-1' }, name: 'Prod S3' })
    const loaded = loadDraft('s3')
    expect(loaded?.formValues).toEqual({ bucket: 'my-logs', region: 'us-east-1' })
    expect(loaded?.name).toBe('Prod S3')
  })

  it('stamps createdAt on save', () => {
    const before = Date.now()
    saveDraft('s3', { formValues: {} })
    const loaded = loadDraft('s3')
    expect(loaded?.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('returns null when nothing has been saved', () => {
    expect(loadDraft('s3')).toBeNull()
  })
})

describe('per-connector-type isolation', () => {
  it('does not leak a draft from one connector type into another', () => {
    saveDraft('s3', { formValues: { bucket: 'a' } })
    expect(loadDraft('elasticsearch')).toBeNull()
    expect(loadDraft('s3')?.formValues.bucket).toBe('a')
  })
})

describe('TTL expiry', () => {
  it('drops and removes a draft older than 7 days', () => {
    const stale: ConnectorDraft = {
      formValues: { bucket: 'old' },
      createdAt: Date.now() - 8 * DAY_MS,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stale))

    expect(loadDraft('s3')).toBeNull()
    // Expiry is destructive: the stale key is purged, not just hidden.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('keeps a draft that is within the 7-day window', () => {
    const fresh: ConnectorDraft = {
      formValues: { bucket: 'recent' },
      createdAt: Date.now() - 6 * DAY_MS,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
    expect(loadDraft('s3')?.formValues.bucket).toBe('recent')
  })
})

describe('corruption safety', () => {
  it('returns null for malformed JSON instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json')
    expect(() => loadDraft('s3')).not.toThrow()
    expect(loadDraft('s3')).toBeNull()
  })

  it('treats a draft missing createdAt as expired', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ formValues: { bucket: 'x' } }))
    expect(loadDraft('s3')).toBeNull()
  })
})

describe('clearDraft', () => {
  it('removes a saved draft', () => {
    saveDraft('s3', { formValues: { bucket: 'a' } })
    clearDraft('s3')
    expect(loadDraft('s3')).toBeNull()
  })
})

describe('degrades silently when storage throws', () => {
  it('saveDraft swallows a storage quota error', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => saveDraft('s3', { formValues: { bucket: 'a' } })).not.toThrow()
  })
})
