// Waits for the API to be healthy, then launches the simulator.
import { execSync } from 'node:child_process'

const MAX_RETRIES = 30
const RETRY_MS = 1000
const HEALTH_URL = 'http://localhost:3000/healthz'

async function waitForApi() {
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetch(HEALTH_URL)
      if (res.ok) {
        console.log(`API healthy after ${i}s`)
        return
      }
    } catch {
      // API not up yet
    }
    if (i % 5 === 0) console.log(`Waiting for API... (${i}s)`)
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }
  console.error(`API not ready after ${MAX_RETRIES}s — starting simulator anyway`)
}

await waitForApi()
execSync('pnpm -C simulator start -- --api-key dev-key', { stdio: 'inherit' })
