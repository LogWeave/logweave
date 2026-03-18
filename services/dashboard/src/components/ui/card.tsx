import type { HTMLAttributes, KeyboardEvent } from 'react'
import { cn } from '../../lib/cn'

type CardSize = 'compact' | 'default' | 'flush'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'interactive'
  size?: CardSize
}

const sizeStyles: Record<CardSize, string> = {
  compact: 'p-3',
  default: 'p-5',
  flush: 'p-0',
}

export function Card({
  className,
  variant = 'default',
  size = 'default',
  children,
  onClick,
  ...props
}: CardProps) {
  const isInteractive = variant === 'interactive'

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (isInteractive && onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onClick(e as unknown as React.MouseEvent<HTMLDivElement>)
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled via onKeyDown spread
    // biome-ignore lint/a11y/noStaticElementInteractions: role="button" applied conditionally
    <div
      className={cn(
        'rounded-[var(--radius-lg)] bg-surface-card border border-border-subtle',
        sizeStyles[size],
        isInteractive &&
          'cursor-pointer transition-colors hover:bg-surface-elevated hover:border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        className,
      )}
      {...(isInteractive ? { role: 'button', tabIndex: 0, onKeyDown: handleKeyDown } : {})}
      onClick={onClick}
      {...props}
    >
      {children}
    </div>
  )
}

export function CardHeader({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('mb-3', className)} {...props}>
      {children}
    </div>
  )
}

export function CardTitle({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn('text-xs font-medium text-text-secondary uppercase tracking-wider', className)}
      {...props}
    >
      {children}
    </h3>
  )
}

export function CardContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn(className)} {...props}>
      {children}
    </div>
  )
}
