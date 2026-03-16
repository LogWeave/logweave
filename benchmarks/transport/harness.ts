import { takeMemorySnapshot } from '../lib/memory.js'
import type { TransportResult, TransportScenario } from '../lib/types.js'

/**
 * Run a transport SDK benchmark scenario.
 * Creates a LogWeaveTransport with a mock fetch and pushes events as fast as possible.
 */
export async function runTransportScenario(scenario: TransportScenario): Promise<TransportResult> {
  // Dynamic import to avoid requiring winston at module load
  const { LogWeaveTransport } = await import('../../packages/transport/src/index.js')

  let batchCount = 0
  let droppedEvents = 0

  // Create mock fetch with configurable latency
  const mockFetch: typeof globalThis.fetch = async (_url, _init) => {
    if (scenario.mock_response_ms === -1) {
      throw new Error('Connection refused (mock)')
    }
    if (scenario.mock_response_ms > 0) {
      await new Promise((r) => setTimeout(r, scenario.mock_response_ms))
    }
    batchCount++
    return new Response(
      JSON.stringify({
        accepted: scenario.buffer_size,
        clustered: scenario.buffer_size,
        unclustered: 0,
        new_templates: 0,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const transport = new LogWeaveTransport({
    apiKey: 'bench-key',
    service: 'bench-transport',
    environment: 'bench',
    bufferSize: scenario.buffer_size,
    flushIntervalMs: scenario.flush_interval_ms,
    maxRetries: 1,
    fetch: mockFetch,
    onDrop: (events) => {
      droppedEvents += events.length
    },
  })

  const memBefore = takeMemorySnapshot()
  const startTime = performance.now()

  // Push events as fast as possible
  for (let i = 0; i < scenario.event_count; i++) {
    transport.write(
      {
        level: 'info',
        message: `Benchmark event ${i.toString()} from user-${(i % 100).toString()}`,
        timestamp: new Date().toISOString(),
        [Symbol.for('level')]: 'info',
      },
      () => {},
    )
  }

  // Flush remaining events
  await transport.closeAsync()

  const durationMs = performance.now() - startTime
  const memAfter = takeMemorySnapshot()

  const eventsPerSecond = durationMs > 0 ? (scenario.event_count / durationMs) * 1000 : 0

  return {
    name: scenario.name,
    description: scenario.description,
    config: {
      event_count: scenario.event_count,
      buffer_size: scenario.buffer_size,
      flush_interval_ms: scenario.flush_interval_ms,
      mock_response_ms: scenario.mock_response_ms,
    },
    results: {
      events_per_second: Math.round(eventsPerSecond),
      total_events: scenario.event_count,
      total_batches: batchCount,
      dropped_events: droppedEvents,
      duration_ms: Math.round(durationMs),
    },
    memory: {
      rss_start_mb: memBefore.rss_mb,
      rss_end_mb: memAfter.rss_mb,
      heap_used_start_mb: memBefore.heap_used_mb,
      heap_used_end_mb: memAfter.heap_used_mb,
    },
    verdict: scenario.mock_response_ms === -1 ? 'PASS' : droppedEvents === 0 ? 'PASS' : 'FAIL',
  }
}
