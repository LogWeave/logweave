/**
 * Archive delivery-metrics integration test (epic #265, #283).
 *
 * Guards the observability wiring against real Vector + Floci's CloudWatch: that
 * the internal_metrics → filter → remap → aws_cloudwatch_metrics topology
 * COMPILES and the cloudwatch sink CONNECTS and delivers to the LogWeave/Archive
 * namespace. This is what static validation misses (and caught a real config
 * crash: Vector interpolates `$` even in comments).
 *
 * SCOPE / Floci fidelity — read before strengthening this test:
 * Floci accepts CloudWatch PutMetricData/alarms, but its metric *query* API is
 * PARTIAL: it surfaces the cloudwatch sink's own `healthcheck` series (which
 * proves the sink reaches CloudWatch in the configured namespace) but does NOT
 * return Vector's emitted data-metrics. So this test CANNOT assert the data
 * metric names or — critically — their dimensions. The reviewer-found bug (the
 * alarm keyed on component_id alone never matched, because the sink maps every
 * tag to a dimension) is fixed by the `archive_dims` remap that strips tags to
 * component_id; that fix is correct by Vector+CloudWatch semantics but is NOT
 * verifiable here. REAL-AWS RESIDUAL: confirm component_errors_total publishes
 * under LogWeave/Archive with exactly {component_id=archive} so the alarm fires.
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
