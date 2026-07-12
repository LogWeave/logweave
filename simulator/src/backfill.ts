import { deriveApiBase, postDeployMarker } from './deploy-marker.js'
import { diurnalFactorAt } from './diurnal.js'
import { TemplateEngine } from './template-engine.js'
import type { ServiceConfig } from './types.js'

const MINUTE_MS = 60_000
const MAX_BATCH = 1000
const WARN_TOTAL = 1_500_000

export interface BackfillOptions {
  services: ServiceConfig[]
  days: number
  /** Events/sec across all services at the diurnal peak. */
  peakRate: number
  apiKey: string
  /** Ingest batch endpoint, e.g. http://localhost:3000/v1/ingest/batch */
  endpoint: string
  dryRun: boolean
}

/** A backfilled event is a normal generated event with a backdated timestamp. */
type Event = Record<string, unknown>

/**
 * Generate diurnally-shaped historical traffic and load it via POST
 * /v1/ingest/batch so LogWeave's 7-day hour-of-day baselines, trends, and
 * correlations are populated immediately instead of after days of live running.
 *
 * Plants one known, verifiable signal: a deploy marker partway through the
 * window with a 30-minute error/spike burst right after it, so deploy-anchored
 * change detection and anomaly detection have something concrete to surface.
 * The planted signal is printed at the end so the operator knows what to check.
 */
export async function runBackfill(opts: BackfillOptions): Promise<void> {
  const { services, days, peakRate, apiKey, endpoint, dryRun } = opts
  const apiBase = deriveApiBase(endpoint)

  const engines = new Map<string, TemplateEngine>()
  for (const svc of services) engines.set(svc.service, new TemplateEngine(svc))

  // Weighted service selection by rate_weight.
  const cumulative: Array<{ service: string; cum: number }> = []
  let totalWeight = 0
  for (const svc of services) {
    totalWeight += svc.rate_weight ?? 1
    cumulative.push({ service: svc.service, cum: totalWeight })
  }
  const pickService = (): string => {
    const roll = Math.random() * totalWeight
    for (const entry of cumulative) if (entry.cum > roll) return entry.service
    return cumulative[cumulative.length - 1]?.service ?? services[0]?.service ?? ''
  }

  const now = Date.now()
  const start = now - days * 24 * 60 * MINUTE_MS

  // Planted signal: a deploy ~60% of the way back, on a service that has a
  // spike config (the canonical "deploy" story), with a 30-minute burst after.
  const plantedService = services.find((s) => s.spike)?.service ?? services[0]?.service ?? ''
  const deployAt = now - Math.round(days * 0.6 * 24 * 60 * MINUTE_MS)
  const burstEnd = deployAt + 30 * MINUTE_MS
  let burstActive = false

  const estimatedTotal = estimateTotal(start, now, peakRate)
  console.log('\x1b[1mLogWeave Simulator — backfill\x1b[0m')
  console.log(`  Window:   ${days}d (${new Date(start).toISOString()} → now)`)
  console.log(`  Peak rate:${peakRate}/s (diurnal-shaped)`)
  console.log(`  Services: ${services.map((s) => s.service).join(', ')}`)
  console.log(`  Estimate: ~${estimatedTotal.toLocaleString()} events`)
  if (estimatedTotal > WARN_TOTAL) {
    console.log(
      `  \x1b[33mWARNING: large backfill — lower --backfill-rate or --backfill days if this is too slow.\x1b[0m`,
    )
  }
  if (dryRun) {
    console.log('  (dry-run — no events sent)\n')
    return
  }
  console.log('')

  // Per-service batches, flushed at MAX_BATCH.
  const batches = new Map<string, Event[]>()
  let sent = 0
  let failed = 0
  let lastProgress = 0

  const flush = async (service: string): Promise<void> => {
    const batch = batches.get(service)
    if (!batch || batch.length === 0) return
    const ok = await postBatch(endpoint, apiKey, service, batch)
    if (ok) sent += batch.length
    else failed += batch.length
    batches.set(service, [])
  }

  for (let bucket = start; bucket < now; bucket += MINUTE_MS) {
    const bucketDate = new Date(bucket)
    const factor = diurnalFactorAt(bucketDate)
    const eventsThisMinute = Math.round(peakRate * 60 * factor)

    // Toggle the planted burst on the canonical service's engine.
    const plantEngine = engines.get(plantedService)
    if (!burstActive && bucket >= deployAt && bucket < burstEnd) {
      plantEngine?.activateSpike()
      plantEngine?.activateErrorStorm()
      burstActive = true
    } else if (burstActive && bucket >= burstEnd) {
      plantEngine?.deactivateErrorStorm()
      plantEngine?.deactivateSpike()
      burstActive = false
    }

    for (let i = 0; i < eventsThisMinute; i++) {
      const service = pickService()
      const engine = engines.get(service)
      if (!engine) continue
      const event = engine.generate()
      event.timestamp = new Date(bucket + Math.floor(Math.random() * MINUTE_MS)).toISOString()

      const batch = batches.get(service) ?? []
      batch.push(event)
      batches.set(service, batch)
      if (batch.length >= MAX_BATCH) await flush(service)
    }

    // Progress every ~10% of the window.
    const pct = Math.floor(((bucket - start) / (now - start)) * 100)
    if (pct >= lastProgress + 10) {
      lastProgress = pct
      console.log(`  ${pct}% — ${sent.toLocaleString()} sent`)
    }
  }

  // Flush remaining.
  for (const service of batches.keys()) await flush(service)

  // Register the planted deploy marker at its historical timestamp.
  const deployIso = new Date(deployAt).toISOString()
  const markerOk = await postDeployMarker(apiBase, apiKey, {
    service: plantedService,
    version: 'sim-backfill-1.0.0',
    timestamp: deployIso,
  })

  if (failed > 0) {
    console.log(
      `\n\x1b[33mBackfill finished with errors.\x1b[0m  ${sent.toLocaleString()} sent, ` +
        `\x1b[33m${failed.toLocaleString()} failed\x1b[0m — planted signals may be incomplete; ` +
        'check the endpoint and API key.',
    )
  } else {
    console.log(`\n\x1b[1mBackfill complete.\x1b[0m  ${sent.toLocaleString()} events sent.`)
  }
  console.log('\x1b[1mPlanted signals (verify LogWeave caught these):\x1b[0m')
  console.log(`  • Diurnal traffic across ${days}d — hour-of-day baselines should be shaped.`)
  console.log(
    `  • Deploy marker: ${plantedService} sim-backfill-1.0.0 @ ${deployIso}` +
      `${markerOk ? '' : '  \x1b[33m(marker POST failed — check admin API key)\x1b[0m'}`,
  )
  console.log(
    `  • 30-min error/spike burst on ${plantedService} right after the deploy — ` +
      'should surface as a post-deploy anomaly / error-rate rise.',
  )
}

/** Approximate total events for the window (avg diurnal factor ≈ 0.6). */
function estimateTotal(start: number, end: number, peakRate: number): number {
  const minutes = (end - start) / MINUTE_MS
  return Math.round(minutes * peakRate * 60 * 0.6)
}

/** POST one batch. Best-effort: logs and swallows errors. Returns true on success. */
async function postBatch(
  endpoint: string,
  apiKey: string,
  service: string,
  events: Event[],
): Promise<boolean> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ events, service }),
    })
    if (!res.ok) {
      console.error(`[backfill] ${service} batch → HTTP ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[backfill] ${service} batch failed: ${(err as Error).message}`)
    return false
  }
}
