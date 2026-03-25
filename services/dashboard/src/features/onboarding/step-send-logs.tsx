import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import { Check, ClipboardCopy } from 'lucide-react'
import { queryKeys } from '../../api/query-keys'
import { config } from '../../config'
import { cn } from '../../lib/cn'
import { curlSnippet, goSnippet, nodeSnippet, otelSnippet, pythonSnippet } from './snippets'

const tabs = [
  { id: 'sdk', label: 'SDK (Node.js)', sub: 'Winston / Pino' },
  { id: 'http', label: 'HTTP API', sub: 'Any language' },
  { id: 'otel', label: 'OpenTelemetry', sub: 'OTel Collector' },
] as const

type TabId = (typeof tabs)[number]['id']

const httpLangs = ['curl', 'Python', 'Go'] as const
type HttpLang = (typeof httpLangs)[number]

interface StepSendLogsProps {
  complete: boolean
}

function PulsingDot() {
  return (
    <span className="relative flex h-3 w-3">
      <span className="absolute inset-0 rounded-full bg-brand-400 opacity-75 animate-ping" />
      <span className="relative inline-flex h-3 w-3 rounded-full bg-brand-400" />
    </span>
  )
}

export function StepSendLogs({ complete }: StepSendLogsProps) {
  const [tab, setTab] = useState<TabId>('http')
  const [httpLang, setHttpLang] = useState<HttpLang>('curl')
  const queryClient = useQueryClient()
  const elapsedRef = useRef(0)
  const [polling, setPolling] = useState(!complete)
  const [copied, setCopied] = useState(false)

  const apiUrl = config.apiUrl || window.location.origin
  const apiKey = config.apiKey

  // Poll for first event
  useEffect(() => {
    if (complete || !polling) return

    const interval = setInterval(() => {
      elapsedRef.current += 5
      queryClient.invalidateQueries({ queryKey: queryKeys.onboardingStatus() })

      // After 5 minutes, stop polling
      if (elapsedRef.current >= 300) {
        setPolling(false)
      }
    }, elapsedRef.current >= 60 ? 10_000 : 5_000)

    return () => clearInterval(interval)
  }, [complete, polling, queryClient])

  const snippet = getSnippet(tab, httpLang, apiUrl, apiKey)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-3">
      <AnimatePresence mode="wait">
        {complete ? (
          <motion.div
            key="complete"
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
            <span>First log received!</span>
          </motion.div>
        ) : (
          <motion.div key="form" exit={{ opacity: 0, height: 0 }} className="space-y-3">
            <p className="text-xs text-text-secondary">
              How do you want to send logs?
            </p>

            {/* Method tabs */}
            <div className="flex gap-1 bg-surface-base rounded-[var(--radius-md)] p-1">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex-1 py-1.5 px-2 rounded-[var(--radius-sm)] text-center transition-colors',
                    tab === t.id
                      ? 'bg-surface-elevated text-text-primary shadow-sm'
                      : 'text-text-muted hover:text-text-secondary',
                  )}
                >
                  <div className="text-xs font-medium">{t.label}</div>
                  <div className="text-[10px] text-text-muted">{t.sub}</div>
                </button>
              ))}
            </div>

            {/* HTTP language selector */}
            {tab === 'http' && (
              <div className="flex gap-1">
                {httpLangs.map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => setHttpLang(lang)}
                    className={cn(
                      'px-2.5 py-1 rounded-[var(--radius-sm)] text-xs transition-colors',
                      httpLang === lang
                        ? 'bg-brand-500/10 text-brand-400'
                        : 'text-text-muted hover:text-text-secondary',
                    )}
                  >
                    {lang}
                  </button>
                ))}
              </div>
            )}

            {/* Code snippet */}
            <div className="relative">
              <pre className="bg-surface-base border border-border-subtle rounded-[var(--radius-md)] p-3 text-xs text-text-secondary overflow-x-auto font-mono leading-relaxed max-h-48">
                {snippet}
              </pre>
              <button
                type="button"
                onClick={handleCopy}
                className="absolute top-2 right-2 p-1.5 rounded-[var(--radius-sm)] bg-surface-elevated/80 hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
                title="Copy to clipboard"
              >
                {copied ? <Check size={14} className="text-success-500" /> : <ClipboardCopy size={14} />}
              </button>
            </div>

            {/* Polling status */}
            <div className="flex items-center gap-2 text-xs">
              {polling ? (
                <>
                  <PulsingDot />
                  <span className="text-text-muted">Waiting for your first log...</span>
                  {elapsedRef.current >= 120 && (
                    <span className="text-warning-500 ml-auto">
                      Haven't received data yet. Check your endpoint URL.
                    </span>
                  )}
                </>
              ) : (
                <span className="text-text-muted">Polling stopped. Refresh the page after sending logs.</span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function getSnippet(tab: TabId, httpLang: HttpLang, apiUrl: string, apiKey: string): string {
  if (tab === 'sdk') return nodeSnippet(apiUrl, apiKey)
  if (tab === 'otel') return otelSnippet(apiUrl, apiKey)
  // HTTP tab
  switch (httpLang) {
    case 'curl': return curlSnippet(apiUrl, apiKey)
    case 'Python': return pythonSnippet(apiUrl, apiKey)
    case 'Go': return goSnippet(apiUrl, apiKey)
  }
}
