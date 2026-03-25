import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Check } from 'lucide-react'
import { useDismissOnboarding } from './use-onboarding'

export function CompletionCard() {
  const dismissMutation = useDismissOnboarding()
  const [visible, setVisible] = useState(true)

  // Auto-dismiss after 5 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      dismissMutation.mutate()
    }, 5000)
    return () => clearTimeout(timer)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.3 }}
      className="rounded-[var(--radius-lg)] border border-success-500/30 bg-surface-card p-6 text-center mb-6 cursor-pointer"
      onClick={() => {
        setVisible(false)
        dismissMutation.mutate()
      }}
    >
      {/* Animated checkmark */}
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
        className="mx-auto mb-3 h-12 w-12 rounded-full bg-success-500/20 flex items-center justify-center"
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <Check size={24} className="text-success-500" />
        </motion.div>
      </motion.div>

      <h3 className="text-sm font-semibold text-text-primary mb-1">You're all set!</h3>
      <p className="text-xs text-text-secondary">
        LogWeave is monitoring your services. Ask your AI assistant about your logs.
      </p>
    </motion.div>
  )
}
