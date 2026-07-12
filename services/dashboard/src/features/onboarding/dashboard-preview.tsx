import { X } from 'lucide-react'
import { motion } from 'motion/react'

interface DashboardPreviewProps {
  onDismiss: () => void
}

/**
 * Animated mini-dashboard that shows what LogWeave looks like with data.
 * Uses motion to stagger-animate fake KPIs, a chart, and template rows.
 * Resolution-independent, theme-aware, no external assets needed.
 */
export function DashboardPreview({ onDismiss }: DashboardPreviewProps) {
  return (
    <div className="relative rounded-[var(--radius-md)] border border-border-subtle bg-surface-base p-4 overflow-hidden">
      <button
        type="button"
        onClick={onDismiss}
        className="absolute top-2 right-2 p-1 text-text-muted hover:text-text-secondary transition-colors z-10"
        title="Dismiss preview"
      >
        <X size={12} />
      </button>

      {/* Mini KPI strip */}
      <div className="flex gap-3 mb-3">
        {[
          { label: 'Events', value: '12,847' },
          { label: 'Patterns', value: '34' },
          { label: 'Services', value: '5' },
          { label: 'Error Rate', value: '0.4%' },
        ].map((kpi, i) => (
          <motion.div
            key={kpi.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 + i * 0.15, duration: 0.4 }}
            className="flex-1 rounded-[var(--radius-sm)] bg-surface-card border border-border-subtle p-2"
          >
            <div className="text-[9px] text-text-muted">{kpi.label}</div>
            <div className="text-xs font-semibold text-text-primary font-mono">{kpi.value}</div>
          </motion.div>
        ))}
      </div>

      {/* Mini volume chart (SVG line) */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8, duration: 0.5 }}
        className="rounded-[var(--radius-sm)] bg-surface-card border border-border-subtle p-2 mb-3"
      >
        <div className="text-[9px] text-text-muted mb-1">Volume (24h)</div>
        <svg
          viewBox="0 0 200 40"
          className="w-full h-8"
          preserveAspectRatio="none"
          role="img"
          aria-label="24-hour log volume sparkline"
        >
          <title>24-hour log volume sparkline</title>
          <motion.path
            d="M0,35 L15,30 L30,32 L45,25 L60,28 L75,18 L90,22 L105,15 L120,12 L135,16 L150,10 L165,8 L180,12 L195,6 L200,8"
            fill="none"
            stroke="var(--color-brand-400)"
            strokeWidth="1.5"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ delay: 1.0, duration: 1.5, ease: 'easeInOut' }}
          />
          <motion.path
            d="M0,35 L15,30 L30,32 L45,25 L60,28 L75,18 L90,22 L105,15 L120,12 L135,16 L150,10 L165,8 L180,12 L195,6 L200,8 L200,40 L0,40 Z"
            fill="var(--color-brand-400)"
            opacity="0.1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.1 }}
            transition={{ delay: 2.0, duration: 0.5 }}
          />
        </svg>
      </motion.div>

      {/* Mini template rows */}
      <div className="space-y-1">
        {[
          { pattern: 'User <*> logged in from <IP>', count: '2,341', level: 'INFO' },
          { pattern: 'Payment processed for order <ID>', count: '891', level: 'INFO' },
          { pattern: 'Connection timeout to <*>', count: '47', level: 'ERROR' },
        ].map((row, i) => (
          <motion.div
            key={row.pattern}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.5 + i * 0.2, duration: 0.3 }}
            className="flex items-center gap-2 rounded-[var(--radius-sm)] bg-surface-card border border-border-subtle px-2 py-1.5"
          >
            <span
              className={`text-[9px] font-mono px-1 rounded ${
                row.level === 'ERROR'
                  ? 'bg-danger-500/10 text-danger-500'
                  : 'bg-brand-500/10 text-brand-400'
              }`}
            >
              {row.level}
            </span>
            <span className="text-[10px] text-text-secondary font-mono truncate flex-1">
              {row.pattern}
            </span>
            <span className="text-[10px] text-text-muted font-mono shrink-0">{row.count}</span>
          </motion.div>
        ))}
      </div>

      {/* Shimmer overlay that pulses gently */}
      <motion.div
        className="absolute inset-0 pointer-events-none bg-gradient-to-r from-transparent via-white/[0.02] to-transparent"
        initial={{ x: '-100%' }}
        animate={{ x: '100%' }}
        transition={{ delay: 3, duration: 2, repeat: Number.POSITIVE_INFINITY, repeatDelay: 4 }}
      />
    </div>
  )
}
