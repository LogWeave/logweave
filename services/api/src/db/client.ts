import type { ClickHouseClient, DataFormat, QueryParams } from '@clickhouse/client'
import { getInternalEvents } from '../internal-events/emitter.js'

/**
 * ClickHouse client wrapper — parameterized queries only.
 */
export class DbClient {
  constructor(private readonly client: ClickHouseClient) {}

  async query<T>(params: QueryParams): Promise<T[]> {
    try {
      const result = await this.client.query({ ...params, format: 'JSONEachRow' })
      return (await result.json()) as T[]
    } catch (err) {
      emitChFailed(err, 'query')
      throw err
    }
  }

  async insert(params: { table: string; values: unknown[]; format: DataFormat }): Promise<void> {
    try {
      await this.client.insert({
        ...params,
        clickhouse_settings: {
          date_time_input_format: 'best_effort',
          async_insert: 1,
          wait_for_async_insert: 1,
        },
      })
    } catch (err) {
      // Skip self-emission for inserts to the internal_events table itself —
      // the emitter's fire-and-forget path catches its own errors and emitting
      // here would amount to recursion into the same broken sink.
      if (params.table !== 'logweave.internal_events') {
        emitChFailed(err, 'insert')
      }
      throw err
    }
  }

  async command(params: { query: string; query_params?: Record<string, unknown> }): Promise<void> {
    try {
      await this.client.command(params)
    } catch (err) {
      emitChFailed(err, 'command')
      throw err
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping()
      return result.success
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

function emitChFailed(err: unknown, queryKind: 'query' | 'insert' | 'command'): void {
  const errName = (err as { name?: string } | undefined)?.name ?? 'unknown'
  const code = (err as { code?: string } | undefined)?.code
  const isConnectionFailure =
    errName === 'ConnectionRefusedError' ||
    errName === 'FetchError' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT'
  getInternalEvents().emit({
    event: isConnectionFailure ? 'clickhouse.unreachable' : 'clickhouse.query_failed',
    severity: 'error',
    code: isConnectionFailure ? 'CH_UNREACHABLE' : 'CH_QUERY_FAILED',
    summary: `clickhouse ${queryKind} failed`,
    fields: { query_kind: queryKind, error_name: errName, error_code: code ?? 'unknown' },
  })
}
