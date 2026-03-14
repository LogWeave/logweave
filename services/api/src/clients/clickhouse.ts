import { type ClickHouseClient, createClient } from '@clickhouse/client'

export function createClickHouseClient(url: string): ClickHouseClient {
  return createClient({ url, database: 'logweave' })
}

export async function pingClickHouse(client: ClickHouseClient): Promise<boolean> {
  try {
    const result = await client.ping()
    return result.success
  } catch {
    return false
  }
}
