/**
 * localStorage-backed draft for an in-progress connector. The S3 quick-create
 * flow generates an ExternalId that only LogWeave knows; if the user closes
 * the tab before saving the connector, the CloudFormation stack they just
 * created has a secret LogWeave can no longer recover.
 *
 * Storing the draft client-side (KISS) lets them return and finish without
 * regenerating the IAM role. localStorage is sufficient: setup is per-admin,
 * cross-device handoff isn't a real use case here, and skipping a server-side
 * draft table avoids a schema/cleanup surface for a low-value feature.
 */

import type { ConnectorType } from '../../api/types'

const KEY_PREFIX = 'logweave.connector-draft.'
const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface ConnectorDraft {
  /** Subset of formValues we want to restore — keep this loose; new keys are forward-compatible. */
  formValues: Record<string, string>
  /** Optional friendly name the user already typed. */
  name?: string
  /** ms since epoch — used to expire stale drafts on read. */
  createdAt: number
}

function key(type: ConnectorType): string {
  return `${KEY_PREFIX}${type}`
}

export function saveDraft(type: ConnectorType, draft: Omit<ConnectorDraft, 'createdAt'>): void {
  try {
    const payload: ConnectorDraft = { ...draft, createdAt: Date.now() }
    localStorage.setItem(key(type), JSON.stringify(payload))
  } catch {
    // Quota / privacy mode / SSR — silently degrade. The flow still works,
    // it just loses the recovery affordance.
  }
}

export function loadDraft(type: ConnectorType): ConnectorDraft | null {
  try {
    const raw = localStorage.getItem(key(type))
    if (!raw) return null
    const parsed = JSON.parse(raw) as ConnectorDraft
    if (typeof parsed?.createdAt !== 'number' || Date.now() - parsed.createdAt > TTL_MS) {
      localStorage.removeItem(key(type))
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearDraft(type: ConnectorType): void {
  try {
    localStorage.removeItem(key(type))
  } catch {
    // ignore
  }
}
