// Handlers return formatted text (markdown) for LLM consumption, not JSON.

export interface ApiResponse {
  data: unknown
  meta: Record<string, unknown>
}

// Template text is unbounded; a single response can carry many rows. Cap each
// rendered value so one tool call can't flood the model's context window.
export const TEMPLATE_TEXT_MAX = 200

export function truncate(value: unknown, max = TEMPLATE_TEXT_MAX): string {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// Escape a value for use inside a GitHub-flavored-markdown table cell. Pipes
// would start a new column and newlines would end the row, so template/log text
// (which can contain either) must be neutralized or it corrupts the table the
// agent reads. Replaces newlines with a space and escapes pipes.
export function escapeCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
}

export function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = []
  if (meta.timeRange) parts.push(`Time range: ${meta.timeRange}`)
  if (meta.dataRetention) parts.push(`Data retention: ${meta.dataRetention}`)
  if (meta.message) parts.push(`Note: ${meta.message}`)
  return parts.length > 0 ? `\n\n---\n${parts.join('\n')}` : ''
}

// Wrap a tool handler so thrown errors become isError responses instead of
// crashing the server. The LLM can then recover (retry, adjust params, inform user).
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export function toolHandler(
  fn: (args: Record<string, unknown>) => Promise<string>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      const text = await fn(args)
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
      }
    }
  }
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

export const WRITE_OP = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const
