import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type TextVariant = 'heading' | 'label' | 'value' | 'body' | 'caption' | 'mono' | 'muted'
type TextSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

interface TextProps extends HTMLAttributes<HTMLElement> {
  variant?: TextVariant
  size?: TextSize
  as?: 'p' | 'span' | 'h1' | 'h2' | 'h3' | 'h4' | 'code' | 'div'
}

const variantStyles: Record<TextVariant, string> = {
  heading: 'font-semibold text-text-primary',
  label: 'font-medium text-text-secondary uppercase tracking-wider',
  value: 'font-bold font-mono tabular-nums text-text-primary',
  body: 'text-text-primary',
  caption: 'text-text-muted',
  mono: 'font-mono text-text-primary',
  muted: 'text-text-muted',
}

const sizeStyles: Record<TextSize, string> = {
  xs: 'text-[11px]',
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-lg',
  xl: 'text-xl',
}

const variantDefaults: Record<TextVariant, TextSize> = {
  heading: 'md',
  label: 'xs',
  value: 'xl',
  body: 'sm',
  caption: 'sm',
  mono: 'sm',
  muted: 'sm',
}

const variantTags: Record<TextVariant, TextProps['as']> = {
  heading: 'h3',
  label: 'span',
  value: 'p',
  body: 'p',
  caption: 'span',
  mono: 'code',
  muted: 'p',
}

export function Text({ variant = 'body', size, as, className, children, ...props }: TextProps) {
  const Tag = as ?? variantTags[variant] ?? 'span'
  const resolvedSize = size ?? variantDefaults[variant]

  return (
    <Tag className={cn(variantStyles[variant], sizeStyles[resolvedSize], className)} {...props}>
      {children}
    </Tag>
  )
}
