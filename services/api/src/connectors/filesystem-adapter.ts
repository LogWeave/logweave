/**
 * Local filesystem log source adapter.
 *
 * Uses node:fs/promises (no new dependencies).
 *
 * testConnection: fs.stat + fs.readdir
 * fetchRawLogs:   list files by mtime, createReadStream + shared scanStream
 *
 * SECURITY: All resolved paths must stay within basePath (path traversal guard).
 */

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scanStream } from './line-scanner.js'
import { templateToRegex } from './template-regex.js'
import {
  type ConnectionTestResult,
  type ConnectorConfig,
  type FetchRawLogsParams,
  type FilesystemConnectorConfig,
  type LogSourceAdapter,
  type RawLogLine,
  type RawLogResult,
  SCAN_DEFAULTS,
} from './types.js'

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

/**
 * Ensure resolved path stays within basePath. Throws on traversal attempts.
 */
function guardPath(basePath: string, targetPath: string): string {
  const resolvedBase = resolve(basePath)
  const resolvedTarget = resolve(targetPath)

  // The resolved target must start with the resolved base + path separator (or equal it)
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(`${resolvedBase}/`) &&
    !resolvedTarget.startsWith(`${resolvedBase}\\`)
  ) {
    throw new Error(`Path traversal rejected: "${targetPath}" escapes base directory`)
  }

  return resolvedTarget
}

// ---------------------------------------------------------------------------
// File listing
// ---------------------------------------------------------------------------

/**
 * Match a filename against a glob-like pattern (supports * and **).
 * This is a minimal implementation covering common cases:
 * - *.log  matches app.log
 * - *.log  does NOT match subdir/app.log
 * - **.log or **\/*.log matches any depth
 */
function matchesPattern(filename: string, pattern: string): boolean {
  // Simple patterns: *.ext or exact match
  if (!pattern.includes('/') && !pattern.includes('\\')) {
    // Single-segment pattern like "*.log"
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*')
    return new RegExp(`^${escaped}$`, 'i').test(filename)
  }

  // Multi-segment pattern with ** — match any depth
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/__GLOBSTAR__/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(filename)
}

interface FileEntry {
  path: string
  name: string
  mtimeMs: number
}

async function listLogFiles(
  basePath: string,
  pattern: string,
  maxFiles: number,
): Promise<FileEntry[]> {
  const resolvedBase = resolve(basePath)
  const files: FileEntry[] = []
  const isRecursive = pattern.includes('**')

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return

    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break

      const fullPath = join(dir, String(entry.name))

      if (entry.isDirectory() && isRecursive) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        // Match against pattern using relative path from basePath
        const relativePath = fullPath.slice(resolvedBase.length + 1).replace(/\\/g, '/')
        const filename = String(entry.name)

        if (matchesPattern(isRecursive ? relativePath : filename, pattern)) {
          try {
            const fileStat = await stat(fullPath)
            files.push({
              path: fullPath,
              name: relativePath,
              mtimeMs: fileStat.mtimeMs,
            })
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
  }

  await walk(resolvedBase)

  // Sort by mtime descending (newest first)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  return files.slice(0, maxFiles)
}

// ---------------------------------------------------------------------------
// FilesystemAdapter
// ---------------------------------------------------------------------------

export class FilesystemAdapter implements LogSourceAdapter {
  readonly type = 'filesystem'

  async testConnection(config: ConnectorConfig): Promise<ConnectionTestResult> {
    const fsConfig = config as FilesystemConnectorConfig

    try {
      const resolvedBase = resolve(fsConfig.basePath)
      const dirStat = await stat(resolvedBase)

      if (!dirStat.isDirectory()) {
        return {
          success: false,
          message: `"${fsConfig.basePath}" is not a directory.`,
        }
      }

      const files = await listLogFiles(resolvedBase, fsConfig.filePattern, 10)

      return {
        success: true,
        message:
          files.length > 0
            ? `Found ${files.length} file(s) matching "${fsConfig.filePattern}".`
            : `Directory accessible but no files matching "${fsConfig.filePattern}".`,
        filesFound: files.length,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOENT')) {
        return {
          success: false,
          message: `Directory "${fsConfig.basePath}" does not exist.`,
        }
      }
      if (msg.includes('EACCES')) {
        return {
          success: false,
          message: `Permission denied: cannot access "${fsConfig.basePath}".`,
        }
      }
      // Catch-all: do not echo the raw error back to the user.
      return {
        success: false,
        message: 'Connection failed. Check the base path and file pattern, then try again.',
      }
    }
  }

  async fetchRawLogs(params: FetchRawLogsParams): Promise<RawLogResult> {
    const config = params.config as FilesystemConnectorConfig
    const regex = templateToRegex(params.templateText)
    const limit = Math.min(params.limit, SCAN_DEFAULTS.maxLimit)
    const resolvedBase = resolve(config.basePath)

    const allFiles = await listLogFiles(resolvedBase, config.filePattern, SCAN_DEFAULTS.maxFiles)

    // Filter files by mtime within the time range
    const startMs = params.timeRange.start.getTime()
    const endMs = params.timeRange.end.getTime()
    const filesInRange = allFiles.filter((f) => f.mtimeMs >= startMs && f.mtimeMs <= endMs)

    const lines: RawLogLine[] = []
    let filesScanned = 0
    let bytesScanned = 0
    let truncated = false
    let truncatedReason: 'file_limit' | 'timeout' | undefined

    const startTime = Date.now()

    for (const file of filesInRange) {
      if (lines.length >= limit) break
      if (Date.now() - startTime > SCAN_DEFAULTS.maxTimeoutMs) {
        truncated = true
        truncatedReason = 'timeout'
        break
      }
      if (filesScanned >= SCAN_DEFAULTS.maxFiles) {
        truncated = true
        truncatedReason = 'file_limit'
        break
      }

      // Path traversal guard
      try {
        guardPath(resolvedBase, file.path)
      } catch {
        continue
      }

      filesScanned++

      try {
        const stream = createReadStream(file.path, { encoding: 'utf8' })
        const result = await scanStream({
          stream,
          regex,
          logFormat: config.logFormat,
          remaining: limit - lines.length,
        })

        bytesScanned += result.bytesRead

        for (const match of result.matches) {
          lines.push({
            message: match.message,
            timestamp: match.timestamp,
            source: file.name,
          })
          if (lines.length >= limit) break
        }
      } catch {}
    }

    if (!truncated && filesInRange.length >= SCAN_DEFAULTS.maxFiles && lines.length < limit) {
      truncated = true
      truncatedReason = 'file_limit'
    }

    return {
      lines,
      hasMore: truncated && lines.length > 0,
      filesScanned,
      bytesScanned,
      truncated,
      truncatedReason,
    }
  }
}

// Export for testing
export { guardPath }
