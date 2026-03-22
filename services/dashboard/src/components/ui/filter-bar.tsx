/**
 * FilterBar — config-driven filter pill bar (GitHub/Linear pattern).
 *
 * Reusable across all dashboard pages. Filter types = configuration, not code.
 * If we swap the popover or pill implementation, only this directory changes.
 */

import { SlidersHorizontal } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { FilterPill } from './filter-pill'
import { Popover } from './popover'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterOption {
  value: string
  label: string
}

export interface FilterDefinition {
  key: string
  label: string
  options: FilterOption[]
}

export interface FilterBarProps {
  definitions: FilterDefinition[]
  values: Record<string, string | undefined>
  onChange: (key: string, value: string | undefined) => void
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FilterBar({ definitions, values, onChange, className }: FilterBarProps) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pillRefs = useRef<Map<string, HTMLSpanElement>>(new Map())

  const activeFilters = definitions.filter((d) => values[d.key] != null)
  const availableCategories = definitions.filter((d) => values[d.key] == null)

  function openCategory(key: string) {
    setSelectedCategory(key)
    setEditingKey(key)
    setPopoverOpen(true)
  }

  function selectValue(key: string, value: string) {
    onChange(key, value)
    setPopoverOpen(false)
    setSelectedCategory(null)
    setEditingKey(null)
  }

  function removeFilter(key: string) {
    onChange(key, undefined)
    setEditingKey(null)
  }

  function clearAll() {
    for (const d of definitions) {
      onChange(d.key, undefined)
    }
    setPopoverOpen(false)
    setSelectedCategory(null)
    setEditingKey(null)
  }

  const currentDef = selectedCategory
    ? definitions.find((d) => d.key === selectedCategory)
    : null

  // Determine which ref to anchor the popover to
  const anchorRef = editingKey && pillRefs.current.has(editingKey)
    ? { current: pillRefs.current.get(editingKey) ?? null }
    : triggerRef

  return (
    <div className={cn('flex items-center gap-2 flex-wrap', className)}>
      {/* Active filter pills */}
      {activeFilters.map((def) => {
        const option = def.options.find((o) => o.value === values[def.key])
        return (
          <span
            key={def.key}
            ref={(el) => {
              if (el) pillRefs.current.set(def.key, el)
              else pillRefs.current.delete(def.key)
            }}
          >
            <FilterPill
              label={def.label}
              value={option?.label ?? values[def.key] ?? ''}
              active={editingKey === def.key && popoverOpen}
              onClick={() => openCategory(def.key)}
              onRemove={() => removeFilter(def.key)}
            />
          </span>
        )
      })}

      {/* Add filter button */}
      {availableCategories.length > 0 && (
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-2.5 py-1',
            'text-[11px] text-text-muted hover:text-text-primary hover:bg-surface-elevated transition-colors cursor-pointer',
            popoverOpen && !editingKey && 'bg-surface-elevated text-text-primary',
          )}
          onClick={() => {
            setSelectedCategory(null)
            setEditingKey(null)
            setPopoverOpen(!popoverOpen)
          }}
        >
          <SlidersHorizontal size={11} />
          Filter
        </button>
      )}

      {/* Clear all */}
      {activeFilters.length > 0 && (
        <button
          type="button"
          className="text-[10px] text-text-muted hover:text-text-primary transition-colors cursor-pointer bg-transparent border-0 p-0"
          onClick={clearAll}
        >
          Clear all
        </button>
      )}

      {/* Popover — shows categories or options */}
      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          setPopoverOpen(open)
          if (!open) {
            setSelectedCategory(null)
            setEditingKey(null)
          }
        }}
        anchorRef={anchorRef}
        minWidth={180}
      >
        {currentDef ? (
          // Options for selected category
          <div className="py-1">
            <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider font-medium">
              {currentDef.label}
            </div>
            {currentDef.options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={cn(
                  'w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer',
                  'hover:bg-surface-elevated',
                  values[currentDef.key] === opt.value
                    ? 'text-brand-400 bg-brand-500/5'
                    : 'text-text-primary',
                )}
                onClick={() => selectValue(currentDef.key, opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : (
          // Category selection
          <div className="py-1">
            <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider font-medium">
              Add filter
            </div>
            {availableCategories.map((def) => (
              <button
                key={def.key}
                type="button"
                className="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-surface-elevated transition-colors cursor-pointer"
                onClick={() => setSelectedCategory(def.key)}
              >
                {def.label}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  )
}
