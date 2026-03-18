import { Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

const popoverClass = cn(
  'pointer-events-none absolute z-50 w-60 rounded-md px-2.5 py-2',
  'bg-surface-card border border-border shadow-lg',
  'text-xs text-text-secondary leading-relaxed whitespace-normal',
  'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
  // position: above by default, centred on trigger
  'bottom-full left-1/2 -translate-x-1/2 mb-2',
)

/**
 * Inline ⓘ icon that reveals a tooltip on hover.
 * Use next to labels for metric explanations.
 */
export function InfoTooltip({ content, className }: { content: string; className?: string }) {
  return (
    <span className={cn('group relative inline-flex items-center', className)}>
      <Info size={11} className="text-text-muted cursor-help" aria-hidden="true" />
      <span role="tooltip" className={popoverClass}>
        {content}
      </span>
    </span>
  )
}

/**
 * Wraps any element and shows a tooltip on hover.
 * Use for badges, values, and other non-label elements.
 */
export function Tooltip({
  content,
  children,
  className,
}: {
  content: string
  children: ReactNode
  className?: string
}) {
  return (
    <span className={cn('group relative inline-flex items-center', className)}>
      {children}
      <span role="tooltip" className={popoverClass}>
        {content}
      </span>
    </span>
  )
}
