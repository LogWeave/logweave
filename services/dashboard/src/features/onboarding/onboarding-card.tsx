import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronDown, CircleDot, Rocket, Send, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useDismissOnboarding, useOnboardingStatus } from './use-onboarding'
import { StepSendLogs } from './step-send-logs'
import { StepConnectAi } from './step-connect-ai'
import { StepClustering } from './step-clustering'
import { CompletionCard } from './completion-card'
import { DashboardPreview } from './dashboard-preview'

type StepId = 'send-logs' | 'connect-ai' | 'clustering'

interface StepDef {
  id: StepId
  label: string
  time: string
  icon: typeof Send
  complete: boolean
}

export function OnboardingCard() {
  const { data: response, isLoading } = useOnboardingStatus()
  const status = response?.data
  const dismissMutation = useDismissOnboarding()
  const [expandedStep, setExpandedStep] = useState<StepId | null>(null)
  const [showPreview, setShowPreview] = useState(true)

  if (isLoading || !status) return null
  if (status.dismissed) return null

  const allDone = status.hasEvents && status.mcpConnected && status.clusteringConfigured

  if (allDone) return <CompletionCard />

  const steps: StepDef[] = [
    { id: 'send-logs', label: 'Send your first logs', time: '~2 min', icon: Send, complete: status.hasEvents },
    { id: 'connect-ai', label: 'Connect your AI assistant', time: '~1 min', icon: Sparkles, complete: status.mcpConnected },
    { id: 'clustering', label: 'Tune clustering sensitivity', time: '~1 min', icon: SlidersHorizontal, complete: status.clusteringConfigured },
  ]

  const completedCount = steps.filter((s) => s.complete).length
  const isEmpty = !status.hasEvents

  const toggle = (id: StepId) => {
    setExpandedStep((prev) => (prev === id ? null : id))
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        'rounded-[var(--radius-lg)] border border-border-subtle bg-surface-card overflow-hidden',
        isEmpty ? 'mb-6' : 'mb-4',
      )}
    >
      {/* Header */}
      <div className="p-5 pb-0">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <Rocket size={18} className="text-brand-400" />
            <h2 className="text-sm font-semibold text-text-primary">Get started with LogWeave</h2>
            <span className="text-xs text-text-muted">
              {completedCount}/{steps.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => dismissMutation.mutate()}
            className="text-text-muted hover:text-text-secondary transition-colors p-1 -m-1"
            title="Dismiss setup"
          >
            <X size={16} />
          </button>
        </div>

        <p className="text-xs text-text-secondary mb-4 max-w-xl">
          LogWeave extracts patterns from your logs. Your AI queries the patterns. Raw logs stay in
          your infrastructure.
        </p>

        {/* Dashboard preview (only when no data yet) */}
        {isEmpty && showPreview && (
          <div className="mb-4">
            <DashboardPreview onDismiss={() => setShowPreview(false)} />
          </div>
        )}
      </div>

      {/* Checklist */}
      <div className="border-t border-border-subtle">
        {steps.map((step) => {
          const isExpanded = expandedStep === step.id
          return (
            <div key={step.id} className="border-b border-border-subtle last:border-b-0">
              <button
                type="button"
                onClick={() => toggle(step.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors',
                  'hover:bg-surface-elevated',
                  isExpanded && 'bg-surface-elevated',
                )}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {step.complete ? (
                    <motion.div
                      key="done"
                      initial={{ scale: 0, rotate: -90 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                      className="h-5 w-5 rounded-full bg-success-500/20 flex items-center justify-center shrink-0"
                    >
                      <Check size={12} className="text-success-500" />
                    </motion.div>
                  ) : (
                    <motion.div key="pending" exit={{ scale: 0 }} className="shrink-0">
                      <CircleDot size={20} className="text-text-muted" />
                    </motion.div>
                  )}
                </AnimatePresence>
                <span
                  className={cn(
                    'text-sm flex-1',
                    step.complete ? 'text-text-muted line-through' : 'text-text-primary font-medium',
                  )}
                >
                  {step.label}
                </span>
                <span className="text-xs text-text-muted mr-2">{step.time}</span>
                <ChevronDown
                  size={14}
                  className={cn(
                    'text-text-muted transition-transform duration-200',
                    isExpanded && 'rotate-180',
                  )}
                />
              </button>

              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-5 pb-4 pt-1">
                      {step.id === 'send-logs' && <StepSendLogs complete={step.complete} />}
                      {step.id === 'connect-ai' && <StepConnectAi complete={step.complete} />}
                      {step.id === 'clustering' && <StepClustering complete={step.complete} />}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>

      {/* Skip link */}
      <div className="px-5 py-3 border-t border-border-subtle bg-surface-raised/50">
        <button
          type="button"
          onClick={() => dismissMutation.mutate()}
          className="text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          I'll set this up later
        </button>
      </div>
    </motion.div>
  )
}
