// Wait 3 seconds for the API to start, then launch the simulator
import { execSync } from 'node:child_process'

await new Promise((r) => setTimeout(r, 3000))
execSync('pnpm -C simulator start -- --api-key dev-key', { stdio: 'inherit' })
