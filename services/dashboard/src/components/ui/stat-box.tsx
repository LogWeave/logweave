import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

interface StatBoxProps {
  label: ReactNode
  value: ReactNode
  valueClassName?: string
  className?: string
  secondary?: ReactNode
}

export function StatBox({ label, value, valueClassName, className, secondary }: StatBoxProps) {
  return (
    <div className={cn('bg-surface-base rounded-[var(--radius-md)] p-3', className)}>
      <p className="text-[11px] text-text-muted mb-1">{label}</p>
      <p
        className={cn('text-lg font-bold font-mono tabular-nums text-text-primary', valueClassName)}
      >
        {value}
      </p>
      {secondary && (
        <p className="text-[10px] text-brand-400 mt-0.5">{secondary}</p>
      )}
    </div>
  )
}
