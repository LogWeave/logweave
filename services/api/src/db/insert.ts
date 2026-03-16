import type { DbClient } from './client.js'
import type { LogMetadataRow } from '../types.js'

/**
 * Batch insert log metadata rows into ClickHouse.
 * Synchronous batch insert — no async_insert (adds latency with no
 * throughput benefit when application-side batching is already in place).
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
