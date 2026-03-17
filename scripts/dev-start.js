// Starts the full LogWeave dev stack:
// 1. Ensures Docker containers (ClickHouse + clusterer) are running
// 2. Launches API + dashboard + simulator via concurrently
import { execSync } from 'node:child_process'

function run(cmd) {
  console.log(`\x1b[36m> ${cmd}\x1b[0m`)
  execSync(cmd, { stdio: 'inherit' })
}

function check(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

// Step 1: Start Docker containers if not running
const chStatus = check('docker inspect --format={{.State.Health.Status}} logweave-clickhouse-1')
if (chStatus !== 'healthy') {
  console.log('\n\x1b[33mStarting Docker containers...\x1b[0m')
  run('docker compose up clickhouse clusterer -d')

  console.log('Waiting for ClickHouse...')
  for (let i = 0; i < 30; i++) {
    const s = check('docker inspect --format={{.State.Health.Status}} logweave-clickhouse-1')
    if (s === 'healthy') break
    execSync('node -e "setTimeout(()=>{},2000)"')
  }
  console.log('\x1b[32mClickHouse healthy\x1b[0m\n')
} else {
  const clStatus = check('docker inspect --format={{.State.Status}} logweave-clusterer-1')
  if (clStatus !== 'running') {
    run('docker compose up clusterer -d')
  }
  console.log('\x1b[32mDocker containers already running\x1b[0m\n')
}

// Step 2: Launch everything with concurrently (execSync so it inherits terminal)
run('npx concurrently -k -n api,dashboard,simulator -c blue,magenta,yellow "pnpm -C services/api dev" "pnpm -C services/dashboard dev" "node scripts/delay-simulate.js"')
