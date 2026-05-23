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

export interface BaselineSpec {
  tenantId: string
  service: string
  templateId: string
  avgCount: number
}

/**
 * Mock DbClient that returns anomaly baseline rows scoped to the queried
 * tenant_id. Matches the shape of `queryAnomalyBaselines`. Use when a test
 * needs to feed baselines into AnomalyScorer.refreshBaselines() without
 * reaching into the scorer's private state.
 */
export function createBaselineMockDb(baselines: BaselineSpec[]): DbClient {
  return {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      const tenantId = params.query_params?.tenant_id as string | undefined
      return baselines
        .filter((b) => b.tenantId === tenantId)
        .map((b) => ({
          template_id: b.templateId,
          service: b.service,
          avg_count_per_interval: String(b.avgCount),
        }))
    },
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
