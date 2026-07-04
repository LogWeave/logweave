// CJS smoke test — proves require('@logweave/transport') actually works.
// Run after `pnpm build`, against the built dist/index.cjs, not source.
const assert = require('node:assert/strict')
const path = require('node:path')

const distPath = path.join(__dirname, '..', 'dist', 'index.cjs')
const mod = require(distPath)

assert.equal(
  typeof mod.LogWeaveTransport,
  'function',
  'LogWeaveTransport should be a class/function',
)

const transport = new mod.LogWeaveTransport({
  apiKey: 'test-key',
  service: 'cjs-smoke-test',
  endpoint: 'http://localhost:9999',
})
assert.ok(transport, 'LogWeaveTransport should be constructible from CJS')
transport.close()

console.log('CJS smoke test passed: require("@logweave/transport") works.')
