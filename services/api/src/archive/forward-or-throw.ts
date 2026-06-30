/**
 * Route-side adapter over {@link forwardToVector}: builds the forwarder config
 * from the shared ingest deps and maps a failed forward to a retryable 503 so
 * the durable pump backs off and retries (the batch stays in its spool — no
 * loss). Callers must only invoke this when `deps.vectorArchiveUrl` is set.
 */
import { serviceUnavailable } from '../errors.js'
import type { IngestDeps } from '../lib/ingest-deps.js'
import { type ForwardOptions, forwardToVector, VectorForwardError } from './vector-forwarder.js'

/** Retry-After (seconds) advertised when the archive forward is unavailable. */
const ARCHIVE_RETRY_AFTER_SECONDS = 30

export async function forwardToArchive(
  deps: IngestDeps,
  events: readonly unknown[],
  options: ForwardOptions,
): Promise<void> {
  if (!deps.vectorArchiveUrl) {
    // Programmer error: routes gate on vectorArchiveUrl before calling this.
    throw new Error('forwardToArchive called without vectorArchiveUrl')
  }
  try {
    await forwardToVector(
      { url: deps.vectorArchiveUrl, fetchFn: deps.archiveFetchFn },
      events,
      options,
    )
  } catch (err) {
    if (err instanceof VectorForwardError) {
      deps.logger.warn({ err: err.message, tenantId: options.tenantId }, 'Archive forward failed')
      throw serviceUnavailable('Archive temporarily unavailable', ARCHIVE_RETRY_AFTER_SECONDS)
    }
    throw err
  }
}
