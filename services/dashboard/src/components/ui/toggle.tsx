import { cn } from '../../lib/cn'

interface ToggleGroupProps {
  options: Array<{ value: string; label: string }>
  value: string
  onChange: (value: string) => void
  className?: string
}

export function ToggleGroup({ options, value, onChange, className }: ToggleGroupProps) {
  return (
    <div
      className={cn(
        'inline-flex rounded-[var(--radius-md)] bg-surface-elevated border border-border-subtle p-0.5',
        className,
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-2.5 py-1 text-xs font-medium rounded-[calc(var(--radius-md)-2px)] transition-colors',
            value === opt.value
              ? 'bg-brand-500 text-white shadow-sm'
              : 'text-text-secondary hover:text-text-primary',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
