/**
 * Shared line-scanning utilities for log source adapters.
 *
 * Extracts JSON fields from JSONL lines and scans readable streams for
 * regex-matching log lines. Used by S3, Elasticsearch, Loki, and
 * Filesystem adapters.
 */

import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

// ---------------------------------------------------------------------------
// JSON field extraction
// ---------------------------------------------------------------------------

export interface ExtractedFields {
  message?: string
  timestamp?: string
}

/**
 * Parse a JSON log line and extract the message + timestamp fields.
 * Supports common field names: message/msg for message, timestamp/@timestamp/time for time.
 */
export function extractJsonFields(line: string): ExtractedFields | undefined {
  try {
    const obj = JSON.parse(line)
    return {
      message: obj.message ?? obj.msg ?? undefined,
      timestamp: obj.timestamp ?? obj['@timestamp'] ?? obj.time ?? undefined,
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Stream scanning
// ---------------------------------------------------------------------------

export interface ScanStreamOptions {
  stream: Readable
  regex: RegExp
  logFormat: 'jsonl' | 'text'
  remaining: number
}

export interface ScanStreamResult {
  matches: Array<{ message: string; timestamp?: string }>
  bytesRead: number
}

/**
 * Scan a readable stream line-by-line, collecting lines whose message matches
 * the given regex. Stops after `remaining` matches.
 */
export async function scanStream(options: ScanStreamOptions): Promise<ScanStreamResult> {
  const { stream, regex, logFormat, remaining } = options
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  const matches: Array<{ message: string; timestamp?: string }> = []
  let bytesRead = 0

  try {
    for await (const line of rl) {
      bytesRead += Buffer.byteLength(line, 'utf8')

      let message: string | undefined
      let timestamp: string | undefined

      if (logFormat === 'jsonl') {
        const fields = extractJsonFields(line)
        message = fields?.message
        timestamp = fields?.timestamp
      } else {
        message = line
      }

      if (message && regex.test(message)) {
        matches.push({ message, timestamp })
        if (matches.length >= remaining) break
      }
    }
  } finally {
    rl.close()
  }

  return { matches, bytesRead }
}
