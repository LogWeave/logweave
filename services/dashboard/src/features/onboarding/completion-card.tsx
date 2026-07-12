import { Check } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useDismissOnboarding } from './use-onboarding'

/** CSS-only confetti particles — 8 dots that burst outward from center. */
function ConfettiBurst() {
  const particles = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * 360
    const rad = (angle * Math.PI) / 180
    const x = Math.cos(rad) * 40
    const y = Math.sin(rad) * 40
    const colors = ['bg-brand-400', 'bg-success-500', 'bg-warning-500', 'bg-info-500']
    // The angle uniquely identifies each of the 8 particles and is stable
    // for the lifetime of this burst — a better React key than the array index.
    return { id: `p-${angle}`, x, y, color: colors[i % colors.length], delay: i * 0.03 }
  })

  return (
    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
          animate={{ x: p.x, y: p.y, scale: 0, opacity: 0 }}
          transition={{ delay: 0.3 + p.delay, duration: 0.6, ease: 'easeOut' }}
          className={`absolute h-1.5 w-1.5 rounded-full ${p.color}`}
        />
      ))}
    </div>
  )
}

export function CompletionCard() {
  const dismissMutation = useDismissOnboarding()
  const [visible, setVisible] = useState(true)

  // Auto-dismiss after 5 seconds — mount-once timer. We deliberately don't
  // depend on `dismissMutation` because its identity changes every render
  // and would restart the timer indefinitely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once timer; see note above
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      dismissMutation.mutate()
    }, 5000)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.3 }}
      className="relative rounded-[var(--radius-lg)] border border-success-500/30 bg-surface-card p-6 text-center mb-6 cursor-pointer overflow-hidden"
      onClick={() => {
        setVisible(false)
        dismissMutation.mutate()
      }}
    >
      {/* Glow ring */}
      <motion.div
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: [0, 0.15, 0], scale: [0.5, 1.5, 2] }}
        transition={{ delay: 0.2, duration: 1.2, ease: 'easeOut' }}
        className="absolute inset-0 mx-auto my-auto h-24 w-24 rounded-full bg-success-500 pointer-events-none"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
      />

      {/* Confetti */}
      <ConfettiBurst />

      {/* Animated checkmark */}
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
        className="relative mx-auto mb-3 h-12 w-12 rounded-full bg-success-500/20 flex items-center justify-center"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.3, type: 'spring', stiffness: 300, damping: 12 }}
        >
          <Check size={24} className="text-success-500" strokeWidth={3} />
        </motion.div>
      </motion.div>

      <motion.h3
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="relative text-sm font-semibold text-text-primary mb-1"
      >
        You're all set!
      </motion.h3>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="relative text-xs text-text-secondary"
      >
        LogWeave is monitoring your services. Ask your AI assistant about your logs.
      </motion.p>
    </motion.div>
  )
}
