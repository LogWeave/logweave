import { memo, useEffect, useRef } from 'react'
import { cn } from '../../lib/cn'

interface MiniSparklineProps {
  points: number[]
  width?: number
  height?: number
  className?: string
}

export const MiniSparkline = memo(function MiniSparkline({
  points,
  width = 80,
  height = 28,
  className,
}: MiniSparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || points.length < 2) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    const max = Math.max(...points)
    const min = Math.min(...points)
    const range = max - min || 1
    const padding = 2

    // Determine trend color — read from CSS variables for theme support
    const last = points[points.length - 1] ?? 0
    const first = points[0] ?? 0
    const trending = last > first * 1.2 ? 'up' : last < first * 0.8 ? 'down' : 'flat'
    const styles = getComputedStyle(document.documentElement)
    const warningColor = styles.getPropertyValue('--color-warning').trim() || '#fbbf24'
    const successColor = styles.getPropertyValue('--color-success').trim() || '#34d399'
    const brandColor = styles.getPropertyValue('--color-brand-400').trim() || '#818cf8'
    const strokeColor =
      trending === 'up' ? warningColor : trending === 'down' ? successColor : brandColor
    const stepX = (width - padding * 2) / (points.length - 1)

    // Draw area fill (use globalAlpha for color-format-safe transparency)
    ctx.beginPath()
    ctx.moveTo(padding, height - padding)
    for (let i = 0; i < points.length; i++) {
      const val = points[i] ?? 0
      const x = padding + i * stepX
      const y = padding + (1 - (val - min) / range) * (height - padding * 2)
      ctx.lineTo(x, y)
    }
    ctx.lineTo(padding + (points.length - 1) * stepX, height - padding)
    ctx.closePath()
    ctx.globalAlpha = 0.1
    ctx.fillStyle = strokeColor
    ctx.fill()
    ctx.globalAlpha = 1.0

    // Draw line
    ctx.beginPath()
    for (let i = 0; i < points.length; i++) {
      const val = points[i] ?? 0
      const x = padding + i * stepX
      const y = padding + (1 - (val - min) / range) * (height - padding * 2)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()
  }, [points, width, height])

  if (points.length < 2) {
    return <div className={cn('text-text-muted text-[10px]', className)}>&mdash;</div>
  }

  return <canvas ref={canvasRef} className={cn(className)} style={{ width, height }} />
})
