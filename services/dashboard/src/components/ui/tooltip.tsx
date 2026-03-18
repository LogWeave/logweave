import { Info } from 'lucide-react'
import { type ReactNode, useCallback, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'

// ---------------------------------------------------------------------------
// Portal tooltip — renders into document.body so no overflow:hidden can clip it
// ---------------------------------------------------------------------------

interface Pos {
  top: number
  left: number
}

function TooltipPortal({ id, content, pos }: { id: string; content: string; pos: Pos }) {
  return createPortal(
    <div
      id={id}
      role="tooltip"
      style={{
        position: 'fixed',
        top: pos.top - 8,
        left: pos.left,
        transform: 'translate(-50%, -100%)',
        zIndex: 9999,
        maxWidth: '14rem',
        pointerEvents: 'none',
      }}
      className="rounded-md px-2.5 py-2 bg-surface-card border border-border shadow-xl text-xs text-text-secondary leading-relaxed"
    >
      {content}
    </div>,
    document.body,
  )
}

function useTooltip() {
  const ref = useRef<HTMLElement | null>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  const show = useCallback(() => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect()
      setPos({ top: r.top, left: r.left + r.width / 2 })
    }
  }, [])

  const hide = useCallback(() => setPos(null), [])

  return { ref, pos, show, hide }
}

// ---------------------------------------------------------------------------
// InfoTooltip — ⓘ icon trigger, use next to labels
// ---------------------------------------------------------------------------

export function InfoTooltip({ content, className }: { content: string; className?: string }) {
  const { ref, pos, show, hide } = useTooltip()
  const tooltipId = useId()

  return (
    <button
      type="button"
      ref={ref as React.RefObject<HTMLButtonElement>}
      className={cn('inline-flex items-center cursor-help bg-transparent border-0 p-0', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={pos ? tooltipId : undefined}
    >
      <Info size={11} className="text-text-muted" aria-hidden="true" />
      {pos && <TooltipPortal id={tooltipId} content={content} pos={pos} />}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Tooltip — wraps any element, shows tooltip on hover
// ---------------------------------------------------------------------------

export function Tooltip({
  content,
  children,
  className,
}: {
  content: string
  children: ReactNode
  className?: string
}) {
  const { ref, pos, show, hide } = useTooltip()
  const tooltipId = useId()

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: tooltip trigger needs hover+focus events
    <span
      ref={ref as React.RefObject<HTMLSpanElement>}
      className={cn('inline-flex items-center', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={pos ? tooltipId : undefined}
    >
      {children}
      {pos && <TooltipPortal id={tooltipId} content={content} pos={pos} />}
    </span>
  )
}
