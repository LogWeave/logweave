import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-[var(--radius-md)] bg-surface-elevated border border-border px-3 text-sm text-text-primary placeholder:text-text-muted',
        'focus:outline-2 focus:outline-offset-2 focus:outline-brand-500',
        className,
      )}
      {...props}
    />
  )
}
