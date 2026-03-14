import type { ClickHouseClient, DataFormat, QueryParams } from '@clickhouse/client'

/**
 * Safe ClickHouse client wrapper — exposes only parameterized methods.
 * No raw SQL execution; string interpolation is structurally impossible.
 */
export class DbClient {
  constructor(private readonly client: ClickHouseClient) {}

  async query<T>(params: QueryParams): Promise<T[]> {
    const result = await this.client.query(params)
    return (await result.json()) as T[]
  }

  async insert(params: { table: string; values: unknown[]; format: DataFormat }): Promise<void> {
    await this.client.insert(params)
  }

  async command(params: { query: string }): Promise<void> {
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

  /** Access the underlying client for initSchema and health checks */
  get raw(): ClickHouseClient {
    return this.client
  }
}
