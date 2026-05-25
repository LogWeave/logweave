import { X } from 'lucide-react'
import { cn } from '../../lib/cn'

interface FilterPillProps {
  label: string
  value: string
  onRemove: () => void
  onClick: () => void
  active?: boolean
}

export function FilterPill({ label, value, onRemove, onClick, active }: FilterPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all cursor-pointer',
        active
          ? 'border-brand-500/40 bg-brand-500/10 ring-2 ring-brand-500/20 text-brand-400'
          : 'border-border-subtle bg-surface-base text-text-primary hover:bg-surface-elevated',
      )}
    >
      <button
        type="button"
        className="bg-transparent border-0 p-0 cursor-pointer"
        onClick={onClick}
      >
        <span className="text-text-muted">{label}:</span> <span>{value}</span>
      </button>
      <button
        type="button"
        className="bg-transparent border-0 p-0 ml-0.5 text-text-muted hover:text-text-primary cursor-pointer transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label={`Remove ${label} filter`}
      >
        <X size={10} />
      </button>
    </span>
  )
}
