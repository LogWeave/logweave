/**
 * Server-side root allowlist for the filesystem connector.
 *
 * The filesystem adapter's own `guardPath` only stops traversal *outside*
 * `basePath` — but `basePath` is admin-controlled and API keys are always
 * "admin", so any tenant key could set `basePath:"/"` and read any file the API
 * process can (e.g. `/proc/self/environ` → LOGWEAVE_ENCRYPTION_KEY, or the
 * bootstrap-credentials file). This module adds a *server-operator* allowlist of
 * permitted roots, enforced at connector create-time AND at fetch-time.
 *
 * The allowlist is read from `LOGWEAVE_FILESYSTEM_ROOTS` (comma-separated
 * absolute paths), mirroring how safe-fetch reads LOGWEAVE_CONNECTOR_ALLOWED_HOSTS.
 * **Empty/unset ⇒ the filesystem connector is disabled** (fail-closed): no roots
 * means nothing is allowed.
 *
 * All checks resolve real (symlink-free) paths via `fs.realpath` on both the
 * candidate and the configured roots, so a symlink inside an allowed root cannot
 * be used to escape it, and macOS's `/tmp`→`/private/tmp` style root symlinks
 * still match.
 */

import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/**
 * Parse the configured filesystem root allowlist. Each entry is resolved to an
 * absolute path (but not yet realpath'd — that happens per-check, since roots
 * may not all exist). Returns an empty array when unset ⇒ connector disabled.
 */
export function allowedFilesystemRoots(): string[] {
  const raw = process.env.LOGWEAVE_FILESYSTEM_ROOTS ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => resolve(s))
}

/** True if `candidate` equals `root` or is nested under it (path-segment aware). */
function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  return candidate.startsWith(rootWithSep)
}

/**
 * Resolve `candidate` to its real (symlink-free) path and assert it sits within
 * one of the server-allowed roots. Returns the canonical realpath on success.
 *
 * Throws when the allowlist is empty (connector disabled), when `candidate`
 * doesn't exist, or when it resolves outside every allowed root. The message is
 * safe to surface to an admin (it names no other filesystem contents).
 */
export async function assertWithinAllowedRoots(candidate: string): Promise<string> {
  const roots = allowedFilesystemRoots()
  if (roots.length === 0) {
    throw new Error(
      'Filesystem connector is disabled: the server has no allowed roots configured. ' +
        'Set LOGWEAVE_FILESYSTEM_ROOTS to a comma-separated list of permitted directories.',
    )
  }

  let real: string
  try {
    // realpath resolves symlinks, so a link inside an allowed root can't escape it.
    real = await realpath(candidate)
  } catch {
    throw new Error(
      `Path "${candidate}" does not exist or is not within an allowed filesystem root.`,
    )
  }

  for (const root of roots) {
    let realRoot: string
    try {
      // Canonicalize the root too (it may itself be a symlink, e.g. /tmp on macOS).
      realRoot = await realpath(root)
    } catch {
      // A configured root that doesn't exist on this host can't match anything.
      continue
    }
    if (isWithin(realRoot, real)) return real
  }

  throw new Error(`Path "${candidate}" is outside the allowed filesystem roots.`)
}
