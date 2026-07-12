import { ElasticsearchAdapter } from './elasticsearch-adapter.js'
import { FilesystemAdapter } from './filesystem-adapter.js'
import { LokiAdapter } from './loki-adapter.js'
import { S3Adapter } from './s3-adapter.js'
import type { LogSourceAdapter } from './types.js'

// ---------------------------------------------------------------------------
// Adapter registry — stateless adapters, safe to share across routes
// ---------------------------------------------------------------------------

const adapters: ReadonlyMap<string, LogSourceAdapter> = new Map<string, LogSourceAdapter>([
  ['s3', new S3Adapter()],
  ['elasticsearch', new ElasticsearchAdapter()],
  ['loki', new LokiAdapter()],
  ['filesystem', new FilesystemAdapter()],
])

/**
 * Return the adapter for the given connector type.
 * Throws if the type is unknown.
 */
export function getAdapter(type: string): LogSourceAdapter {
  const adapter = adapters.get(type)
  if (!adapter) {
    throw new Error(`Unknown connector type: ${type}`)
  }
  return adapter
}
