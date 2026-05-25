import { Check, ClipboardCopy, MessageSquareText } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { config } from '../../config'
import { cn } from '../../lib/cn'
import { mcpSnippet } from './snippets'

interface StepConnectAiProps {
  complete: boolean
}

const examplePrompts = [
  'What new error patterns appeared after my last deploy?',
  'Is my payment-service error rate abnormal right now?',
  'What other services are affected when auth times out?',
]

export function StepConnectAi({ complete }: StepConnectAiProps) {
  const [copied, setCopied] = useState(false)
  const [showRest, setShowRest] = useState(false)

  const apiUrl = config.apiUrl || 'http://localhost:3000'
  const apiKey = config.apiKey
  const hasApiKey = apiKey.length > 0
  const snippet = mcpSnippet(apiUrl, apiKey)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (complete) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="flex items-center gap-2 text-success-500 text-sm"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 400, damping: 15 }}
          className="h-5 w-5 rounded-full bg-success-500/20 flex items-center justify-center"
        >
          <Check size={12} />
        </motion.div>
        <span>AI assistant connected!</span>
      </motion.div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Value proposition */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <MessageSquareText size={16} className="text-brand-400" />
          <p className="text-xs font-medium text-text-primary">
            Ask your AI about your production logs
          </p>
        </div>
        <p className="text-xs text-text-secondary mb-3">
          LogWeave connects to AI coding assistants via MCP (Model Context Protocol). Once
          connected, your AI can answer questions like:
        </p>
        <ul className="space-y-1.5 mb-3">
          {examplePrompts.map((prompt) => (
            <li key={prompt} className="flex items-start gap-2 text-xs">
              <span className="text-brand-400 mt-0.5 shrink-0">"</span>
              <span className="text-text-secondary italic">{prompt}</span>
              <span className="text-brand-400 mt-0.5 shrink-0">"</span>
            </li>
          ))}
        </ul>
      </div>

      {/* MCP config snippet */}
      <div>
        {!hasApiKey && (
          <div className="mb-2 rounded-[var(--radius-md)] border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-xs text-warning-400">
            Replace <code className="font-mono">YOUR_API_KEY</code> with a key from your{' '}
            <code className="font-mono">LOGWEAVE_API_KEYS</code> environment variable.
          </div>
        )}
        <p className="text-xs text-text-muted mb-2">
          Paste into your editor's MCP config (Claude Code, Cursor, Windsurf, VS Code):
        </p>
        <div className="relative">
          <pre className="bg-surface-base border border-border-subtle rounded-[var(--radius-md)] p-3 text-xs text-text-secondary overflow-x-auto font-mono leading-relaxed">
            {snippet}
          </pre>
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1.5 rounded-[var(--radius-sm)] bg-surface-elevated/80 hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
            title="Copy to clipboard"
          >
            {copied ? (
              <Check size={14} className="text-success-500" />
            ) : (
              <ClipboardCopy size={14} />
            )}
          </button>
        </div>
      </div>

      {/* REST API fallback */}
      <div>
        <button
          type="button"
          onClick={() => setShowRest(!showRest)}
          className={cn(
            'text-xs transition-colors',
            showRest ? 'text-text-secondary' : 'text-text-muted hover:text-text-secondary',
          )}
        >
          {showRest ? '▾' : '▸'} Using a different AI tool? LogWeave also has a full REST API.
        </button>
        {showRest && (
          <div className="mt-2 text-xs text-text-muted bg-surface-base border border-border-subtle rounded-[var(--radius-md)] p-3">
            <p className="mb-1">
              All MCP tools map directly to REST endpoints under{' '}
              <code className="text-brand-400">/v1/</code>:
            </p>
            <ul className="space-y-0.5 font-mono text-[11px]">
              <li>GET /v1/dashboard/overview</li>
              <li>GET /v1/dashboard/templates?hours=24</li>
              <li>GET /v1/services/:name/health</li>
              <li>GET /v1/templates/search?q=error</li>
            </ul>
          </div>
        )}
      </div>

      <p className="text-[10px] text-text-disabled">
        Completion is detected automatically when the MCP server makes its first API call.
      </p>
    </div>
  )
}
