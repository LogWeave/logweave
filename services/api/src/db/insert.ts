import type { LogMetadataRow } from '../types.js'
import type { DbClient } from './client.js'

/**
 * Batch insert log metadata rows into ClickHouse.
 * Uses async_insert (server-side coalescing) to reduce part pressure —
 * ClickHouse buffers inserts ~1s and flushes in fewer, larger parts.
 */
export async function batchInsert(db: DbClient, rows: LogMetadataRow[]): Promise<void> {
  if (rows.length === 0) {
    throw new Error('batchInsert requires at least one row')
  }

  await db.insert({
    table: 'logweave.log_metadata',
    values: rows,
    format: 'JSONEachRow',
  })
}
