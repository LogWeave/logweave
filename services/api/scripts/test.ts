import { execSync } from 'node:child_process'
import { globSync } from 'node:fs'

const files = globSync('tests/**/*.test.ts')
if (files.length === 0) {
  console.log('No test files found')
  process.exit(0)
}

console.log(`Running ${files.length} test file(s)...`)
execSync(`node --import tsx --test ${files.join(' ')}`, { stdio: 'inherit' })
