import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'

interface Pos {
  top: number
  left: number
  width: number
}

interface PopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  className?: string
  minWidth?: number
}

export function Popover({
  open,
  onOpenChange,
  anchorRef,
  children,
  className,
  minWidth,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  // Position the popover below the anchor
  useEffect(() => {
    if (!open || !anchorRef.current) {
      setPos(null)
      return
    }
    const r = anchorRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, minWidth ?? 200) })
  }, [open, anchorRef, minWidth])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onOpenChange(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, onOpenChange, anchorRef])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onOpenChange])

  if (!open || !pos) return null

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        minWidth: pos.width,
        zIndex: 9999,
      }}
      className={cn(
        'bg-surface-card border border-border-subtle rounded-[var(--radius-lg)] shadow-xl overflow-hidden',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  )
}
