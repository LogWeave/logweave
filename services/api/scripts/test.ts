import { execSync } from 'node:child_process'
import { globSync } from 'node:fs'

const args = process.argv.slice(2)
const mode = args.find((a) => a === '--unit' || a === '--integration')
const verbose = args.includes('--verbose')
const namePattern = args.find((a) => a.startsWith('--test-name-pattern='))

let files: string[]

// Files that require a running ClickHouse instance
const CLICKHOUSE_FILES = new Set([
  'tests/db/queries.test.ts',
  'tests/db/insert.test.ts',
  'tests/db/mv.test.ts',
  'tests/db/schema.test.ts',
  'tests\\db\\queries.test.ts',
  'tests\\db\\insert.test.ts',
  'tests\\db\\mv.test.ts',
  'tests\\db\\schema.test.ts',
])

if (mode === '--unit') {
  // Unit tests: everything except ClickHouse-dependent files and e2e/integration
  files = globSync('tests/**/*.test.ts').filter(
    (f) =>
      !CLICKHOUSE_FILES.has(f) &&
      !f.startsWith('tests/e2e/') &&
      !f.startsWith('tests\\e2e\\') &&
      !f.startsWith('tests/integration/') &&
      !f.startsWith('tests\\integration\\'),
  )
} else if (mode === '--integration') {
  // Integration tests: db/ + integration/ (needs ClickHouse)
  files = [...globSync('tests/db/**/*.test.ts'), ...globSync('tests/integration/**/*.test.ts')]
} else {
  // Default: all tests
  files = globSync('tests/**/*.test.ts')
}

if (files.length === 0) {
  console.log(`No test files found${mode ? ` for ${mode}` : ''}`)
  process.exit(0)
}

console.log(`Running ${files.length} test file(s)${mode ? ` (${mode.slice(2)})` : ''}...`)

// Build the command
const cmdParts = ['node', '--import', 'tsx', '--test']

// Use dot reporter for compact output (default), spec for verbose
if (verbose) {
  cmdParts.push('--test-reporter', 'spec')
} else {
  cmdParts.push('--test-reporter', 'dot')
}

// Force single-file concurrency. ClickHouse-backed tests (mv, insert, queries)
// share one ClickHouse instance; running multiple test files concurrently
// saturates the async insert / MV propagation pipeline and surfaces as
// flaky "expected at least one row" failures. Pure unit tests don't need
// the parallelism either — overall wall-time impact is small.
cmdParts.push('--test-concurrency=1')

if (namePattern) {
  cmdParts.push(`--test-name-pattern=${namePattern.split('=')[1]}`)
}

cmdParts.push(...files)
execSync(cmdParts.join(' '), { stdio: 'inherit' })
