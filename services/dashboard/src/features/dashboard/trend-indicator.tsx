import { Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '../../lib/cn'

interface TrendIndicatorProps {
  value: number // positive = up, negative = down, 0 = flat
  suffix?: string // e.g., '%'
  className?: string
}

export function TrendIndicator({ value, suffix = '', className }: TrendIndicatorProps) {
  const isUp = value > 0
  const isDown = value < 0
  const Icon = isUp ? TrendingUp : isDown ? TrendingDown : Minus

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        isUp && 'text-danger', // red = trending up (more errors/volume)
        isDown && 'text-success', // green = trending down
        !isUp && !isDown && 'text-text-muted',
        className,
      )}
    >
      <Icon size={12} />
      {value !== 0 && `${Math.abs(value).toFixed(1)}${suffix}`}
    </span>
  )
}
