import { execSync } from 'node:child_process'
import { globSync } from 'node:fs'

const mode = process.argv[2] // --unit or --integration

let files: string[]

if (mode === '--unit') {
  // Unit tests: everything except db/ and e2e/ (no ClickHouse needed)
  files = globSync('tests/**/*.test.ts').filter(
    (f) =>
      !f.startsWith('tests/db/') &&
      !f.startsWith('tests\\db\\') &&
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
execSync(`node --import tsx --test ${files.join(' ')}`, { stdio: 'inherit' })
