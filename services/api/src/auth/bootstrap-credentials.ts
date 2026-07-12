import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type pino from 'pino'

/**
 * Bootstrap credentials persistence.
 *
 * When the API generates a random admin password on first start, it prints to
 * stderr AND writes the password to a file inside the API container at
 * /data/bootstrap-credentials.txt (path is configurable via LOGWEAVE_DATA_DIR).
 *
 * This solves the "I missed the log line" UX problem without storing a long-
 * lived secret: the file is deleted automatically as soon as the admin changes
 * their password for the first time. The window from install to first password
 * change is the only time the secret is on disk.
 *
 * Operators can retrieve the password with:
 *   docker compose exec api cat /data/bootstrap-credentials.txt
 *
 * The file is created with mode 0600 (owner read/write only) so other users
 * on the host system cannot read it.
 *
 * If LOGWEAVE_DATA_DIR is unset, the file write is skipped. The stderr banner
 * is still printed so this is just a recovery convenience, not the only source.
 */

function getCredentialsPath(): string | null {
  const dir = process.env.LOGWEAVE_DATA_DIR
  if (!dir) return null
  return join(dir, 'bootstrap-credentials.txt')
}

export function writeBootstrapCredentials(
  args: { username: string; password: string; tenantId: string },
  logger: pino.Logger,
): void {
  const path = getCredentialsPath()
  if (!path) {
    logger.warn(
      'LOGWEAVE_DATA_DIR not set; skipping bootstrap-credentials file. Capture the password from stderr now.',
    )
    return
  }
  const body = [
    '# LogWeave bootstrap credentials',
    '# This file was created automatically when the API generated the initial',
    '# admin password. It is deleted as soon as that password is changed.',
    `username: ${args.username}`,
    `password: ${args.password}`,
    `tenant:   ${args.tenantId}`,
    '',
  ].join('\n')
  try {
    writeFileSync(path, body, { encoding: 'utf8' })
    chmodSync(path, 0o600)
    logger.info(
      { path },
      'Bootstrap credentials written to disk (will be removed on first password change)',
    )
  } catch (err) {
    logger.warn(
      { err, path },
      'Failed to write bootstrap-credentials file; password is still available on stderr',
    )
  }
}

/** Idempotent: removes the file if present, does nothing if absent. */
export function clearBootstrapCredentials(logger: pino.Logger): void {
  const path = getCredentialsPath()
  if (!path) return
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
    logger.info({ path }, 'Bootstrap credentials file removed (first password change completed)')
  } catch (err) {
    logger.warn({ err, path }, 'Failed to remove bootstrap-credentials file')
  }
}
