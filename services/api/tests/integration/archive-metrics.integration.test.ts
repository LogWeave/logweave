/**
 * Archive delivery-metrics integration test (epic #265, #283).
 *
 * Proves the observability wiring end to end against real Vector + Floci's
 * CloudWatch: Vector's internal_metrics, filtered to the archive sink's delivery
 * health (component_id=archive) and shipped by the aws_cloudwatch_metrics sink,
 * actually land in CloudWatch under the LogWeave/Archive namespace after archive
 * traffic. This is the part static validation misses — that the source→filter→
 * sink topology compiles AND delivers metrics with the namespace mapping the
 * CFN alarm (app.yml) keys on.
 *
 * NOTE on Floci fidelity: Floci accepts CloudWatch PutMetricData/alarms and the
 * pipeline delivers to it, but its metric *query* API is partial — only the
 * healthcheck series reliably surfaces under a namespace filter. So this asserts
 * the wiring (archive metrics reach CloudWatch), not exact counter semantics;
 * the precise alarm-metric (component_errors_total) wants a real-AWS smoke test.
 *
 * Requires the dev stack up (Floci + Vector). Auto-skips if either is down.
 */

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

const FLOCI_ENDPOINT = process.env.FLOCI_ENDPOINT ?? 'http://localhost:4566'
const VECTOR_ENDPOINT = process.env.VECTOR_ENDPOINT ?? 'http://localhost:8686'
const ARCHIVE_URL = `${VECTOR_ENDPOINT}/v1/archive`
const NAMESPACE = 'LogWeave/Archive'

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.status > 0
  } catch {
    return false
  }
}

/** List CloudWatch metric names in a namespace via Floci's query API (no SDK). */
async function listMetricNames(namespace: string): Promise<string[]> {
  const res = await fetch(FLOCI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      Action: 'ListMetrics',
      Namespace: namespace,
      Version: '2010-08-01',
    }),
    signal: AbortSignal.timeout(5000),
  })
  const xml = await res.text()
  return [...xml.matchAll(/<MetricName>([^<]+)<\/MetricName>/g)].map((m) => m[1])
}

describe('Archive delivery metrics → CloudWatch (Vector + Floci)', () => {
  let up = false

  before(async () => {
    up = (await reachable(FLOCI_ENDPOINT)) && (await reachable(ARCHIVE_URL))
  })

  it('ships archive-sink metrics to the LogWeave/Archive namespace', async (t) => {
    if (!up) return t.skip('Floci/Vector not reachable')

    // Drive archive traffic so the sink emits component_id=archive metrics.
    const event = JSON.stringify({
      event_id: '00000000-0000-7000-8000-0000000283ab',
      tenant_id: 't-metrics',
      service: 'svc',
      message: 'metrics probe',
    })
    const res = await fetch(ARCHIVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: `${event}\n`,
      signal: AbortSignal.timeout(35000),
    })
    assert.ok(res.ok, `archive POST should succeed (got ${res.status})`)

    // internal_metrics scrape + cloudwatch sink flush are async; poll briefly.
    let names: string[] = []
    for (let attempt = 0; attempt < 15 && names.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 1000))
      names = await listMetricNames(NAMESPACE)
    }

    assert.ok(
      names.length > 0,
      `expected at least one archive metric in ${NAMESPACE}; the Vector internal_metrics → filter → cloudwatch pipeline delivered none`,
    )
  })
})
