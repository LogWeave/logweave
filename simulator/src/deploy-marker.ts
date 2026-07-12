/**
 * Deploy-marker helper. LogWeave's deploy-anchored change detection
 * ("what changed since the deploy?") needs deploy markers to anchor to, so the
 * simulator registers one via POST /v1/deploys whenever it simulates a deploy
 * (live deploy-spike mode, or a planted historical deploy during backfill).
 */

/** Derive the API base (…/v1) from the configured ingest endpoint (…/v1/ingest/batch). */
export function deriveApiBase(ingestEndpoint: string): string {
  return ingestEndpoint.replace(/\/ingest\/batch\/?$/, '')
}

export interface DeployMarker {
  service: string
  version?: string
  /** ISO timestamp; omit for "now". Used to plant historical markers in backfill. */
  timestamp?: string
}

/**
 * POST a deploy marker. Best-effort: logs and swallows errors so a failed
 * marker never takes down the simulator. Returns true on success.
 *
 * Note: POST /v1/deploys is admin-only — the simulator's API key must belong to
 * an admin to register markers (a viewer key will get 403, logged as a warning).
 */
export async function postDeployMarker(
  apiBase: string,
  apiKey: string,
  marker: DeployMarker,
): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/deploys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(marker),
    })
    if (!res.ok) {
      const hint = res.status === 403 ? ' (deploy markers require an admin API key)' : ''
      console.error(`[deploy-marker] ${marker.service} → HTTP ${res.status}${hint}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[deploy-marker] ${marker.service} failed: ${(err as Error).message}`)
    return false
  }
}
