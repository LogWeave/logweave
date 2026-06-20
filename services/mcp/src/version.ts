import { createRequire } from 'node:module'

/**
 * Single source of truth for the package version. Read from package.json at
 * runtime so the MCP server identity and the HTTP User-Agent never drift from
 * the published version on a bump. `../package.json` resolves correctly both in
 * dev (this file runs from `src/`) and in the published package (compiled to
 * `dist/`, which sits one level under the package root next to package.json).
 */
const requireJson = createRequire(import.meta.url)
const pkg = requireJson('../package.json') as { version: string }

export const VERSION = pkg.version
