import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type BadgeVariant = 'default' | 'new' | 'spike' | 'error' | 'resolved' | 'muted'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-brand-500/10 text-brand-400 border-brand-500/20',
  new: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  spike: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  error: 'bg-red-500/10 text-red-400 border-red-500/20',
  resolved: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  muted: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
}

export function Badge({ variant = 'default', className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider rounded-full border',
        variantStyles[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}
