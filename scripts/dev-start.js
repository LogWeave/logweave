// Starts the full LogWeave dev stack:
// 1. Verifies Docker is available
// 2. Ensures ClickHouse + clusterer containers are running and healthy
// 3. Launches API + dashboard + simulator via concurrently
import { execSync } from 'node:child_process'

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

function run(cmd) {
  console.log(`${CYAN}> ${cmd}${RESET}`)
  execSync(cmd, { stdio: 'inherit' })
}

function check(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function sleep(ms) {
  execSync(`node -e "setTimeout(()=>{},${ms})"`)
}

// Step 0: Verify Docker is available
const dockerVersion = check('docker --version')
if (!dockerVersion) {
  console.error(`${RED}Docker is not installed or not running. Install Docker Desktop and try again.${RESET}`)
  process.exit(1)
}
console.log(`${GREEN}Docker: ${dockerVersion}${RESET}`)

// Step 1: Ensure ClickHouse is running and healthy
const chStatus = check('docker inspect --format={{.State.Health.Status}} logweave-clickhouse-1')
if (chStatus !== 'healthy') {
  console.log(`\n${YELLOW}Starting Docker containers...${RESET}`)
  run('docker compose up clickhouse clusterer -d')

  console.log('Waiting for ClickHouse to be healthy...')
  let healthy = false
  for (let i = 0; i < 30; i++) {
    const s = check('docker inspect --format={{.State.Health.Status}} logweave-clickhouse-1')
    if (s === 'healthy') {
      healthy = true
      break
    }
    sleep(2000)
    if (i % 3 === 2) console.log(`  still waiting... (${(i + 1) * 2}s)`)
  }
  if (!healthy) {
    console.error(`${RED}ClickHouse failed to become healthy after 60s. Check: docker compose logs clickhouse${RESET}`)
    process.exit(1)
  }
  console.log(`${GREEN}ClickHouse healthy${RESET}`)
} else {
  console.log(`${GREEN}ClickHouse already healthy${RESET}`)
}

// Step 2: Ensure clusterer is running
const clStatus = check('docker inspect --format={{.State.Status}} logweave-clusterer-1')
if (clStatus !== 'running') {
  console.log(`${YELLOW}Starting clusterer...${RESET}`)
  run('docker compose up clusterer -d')
  sleep(3000)
}

const clRunning = check('docker inspect --format={{.State.Status}} logweave-clusterer-1')
if (clRunning !== 'running') {
  console.error(`${RED}Clusterer failed to start. Check: docker compose logs clusterer${RESET}`)
  process.exit(1)
}
console.log(`${GREEN}Clusterer running${RESET}\n`)

// Step 3: Launch API + dashboard + simulator
run('npx concurrently -k -n api,dashboard,simulator -c blue,magenta,yellow "pnpm -C services/api dev" "pnpm -C services/dashboard dev" "node scripts/delay-simulate.js"')
