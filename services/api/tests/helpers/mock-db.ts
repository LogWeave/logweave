import type { DbClient } from '../../src/db/client.js'

/**
 * Create a minimal mock DbClient that returns empty results.
 * Use for tests that don't need ClickHouse.
 */
export function createMockDb(): DbClient {
  return {
    query: async () => [],
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

/**
 * Create a mock DbClient that captures queries for assertion.
 * Returns `{ db, queries }` where `queries` is an array of captured query strings.
 */
export function createCapturingDb(
  mockResponses?: Map<string, unknown[]>,
): { db: DbClient; queries: string[] } {
  const queries: string[] = []
  const db = {
    query: async (params: { query: string }) => {
      queries.push(params.query)
      if (mockResponses) {
        for (const [key, value] of mockResponses) {
          if (params.query.includes(key)) return value
        }
      }
      return []
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, queries }
}
