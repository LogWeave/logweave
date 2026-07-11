import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Build/runtime version info, surfaced in /healthz and the startup log so a beta
 * bug report can answer "what version?". `gitSha` is injected at Docker build
 * time via LOGWEAVE_GIT_SHA and falls back to 'dev' for local runs.
 */
function readPackageVersion(): string {
  try {
    // ../package.json resolves the same from src/ (tsx) and dist/ (built).
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = readPackageVersion()
export const GIT_SHA = process.env.LOGWEAVE_GIT_SHA?.trim() || 'dev'
export const versionInfo = { version: VERSION, gitSha: GIT_SHA } as const
