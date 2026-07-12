import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type BadgeVariant = 'default' | 'new' | 'spike' | 'error' | 'resolved' | 'muted'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-brand-500/10 text-brand-400 border-brand-500/20',
  new: 'bg-badge-new/10 text-badge-new border-badge-new/20',
  spike: 'bg-badge-spike/10 text-badge-spike border-badge-spike/20',
  error: 'bg-badge-error/10 text-badge-error border-badge-error/20',
  resolved: 'bg-badge-resolved/10 text-badge-resolved border-badge-resolved/20',
  muted: 'bg-badge-muted/10 text-badge-muted border-badge-muted/20',
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
