import { resolve } from 'node:path'

/**
 * Permitted roots for the local filesystem connector — comma-separated absolute
 * directories in `LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS`.
 *
 * SECURITY: `basePath` is admin-controlled and API keys are always admin, so
 * without an operator-set allowlist a connector could point at `/` and read any
 * file the API process can (e.g. the encryption key via `/proc/self/environ`).
 * Empty by default, which DISABLES the filesystem connector entirely (fail
 * closed). Mirrors `LOGWEAVE_CONNECTOR_ALLOWED_HOSTS` for the S3/SSRF guard.
 */
export function defaultAllowedFsRoots(): string[] {
  const raw = process.env.LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(p))
}

/** Whether `basePath` is one of, or nested under, an allowed root. */
export function isBasePathAllowed(basePath: string, roots: string[]): boolean {
  const resolved = resolve(basePath)
  return roots.some(
    (root) =>
      resolved === root || resolved.startsWith(`${root}/`) || resolved.startsWith(`${root}\\`),
  )
}

/**
 * Throw unless `basePath` resolves within the permitted roots. An empty allowlist
 * disables the connector. The thrown message never echoes the roots or the base
 * path, only the knob to turn — safe to surface to the user.
 */
export function assertBasePathAllowed(
  basePath: string,
  roots: string[] = defaultAllowedFsRoots(),
): void {
  if (roots.length === 0) {
    throw new Error(
      'Filesystem connectors are disabled. Set LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS to a ' +
        'comma-separated list of permitted absolute directories to enable them.',
    )
  }
  if (!isBasePathAllowed(basePath, roots)) {
    throw new Error(
      'basePath is outside the permitted filesystem roots (LOGWEAVE_CONNECTOR_ALLOWED_FS_ROOTS).',
    )
  }
}
