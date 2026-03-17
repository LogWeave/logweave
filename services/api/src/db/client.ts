import type { ClickHouseClient, DataFormat, QueryParams } from '@clickhouse/client'

/**
 * ClickHouse client wrapper — parameterized queries only.
 */
export class DbClient {
  constructor(private readonly client: ClickHouseClient) {}

  async query<T>(params: QueryParams): Promise<T[]> {
    const result = await this.client.query({ ...params, format: 'JSONEachRow' })
    return (await result.json()) as T[]
  }

  async insert(params: { table: string; values: unknown[]; format: DataFormat }): Promise<void> {
    await this.client.insert({
      ...params,
      clickhouse_settings: { date_time_input_format: 'best_effort' },
    })
  }

  async command(params: { query: string; query_params?: Record<string, unknown> }): Promise<void> {
    await this.client.command(params)
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
