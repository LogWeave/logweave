import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Eye, EyeOff, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { useSparklines, useTemplates } from '../../api/queries'
import type { TemplateRow } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Skeleton } from '../../components/ui/skeleton'
import { InfoTooltip } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { TOOLTIPS } from '../../lib/tooltips'
import { useDashboardStore } from '../../stores/dashboard-store'
import { MiniSparkline } from './mini-sparkline'

const columnHelper = createColumnHelper<TemplateRow>()

export function TemplateTable({ className }: { className?: string }) {
  const { data: response, isLoading } = useTemplates()
  const templates = response?.data ?? []

  const templateIds = useMemo(() => templates.map((t) => t.templateId), [templates])
  const { data: sparklineResponse } = useSparklines(templateIds.slice(0, 20))
  const sparklineData = sparklineResponse?.data ?? {}

  // Stable ref for sparkline data — columns read from this at render time
  // without needing to be in the columns useMemo dependency array
  const sparklineRef = useRef(sparklineData)
  sparklineRef.current = sparklineData

  const {
    selectedTemplateId,
    setSelectedTemplateId,
    hiddenTemplateIds,
    toggleHideTemplate,
    hideAllTemplates,
    unhideAllTemplates,
    showHidden,
    toggleShowHidden,
  } = useDashboardStore(
    useShallow((s) => ({
      selectedTemplateId: s.selectedTemplateId,
      setSelectedTemplateId: s.setSelectedTemplateId,
      hiddenTemplateIds: s.hiddenTemplateIds,
      toggleHideTemplate: s.toggleHideTemplate,
      hideAllTemplates: s.hideAllTemplates,
      unhideAllTemplates: s.unhideAllTemplates,
      showHidden: s.showHidden,
      toggleShowHidden: s.toggleShowHidden,
    })),
  )

  const visibleTemplates = useMemo(() => {
    if (showHidden) return templates
    return templates.filter((t) => !hiddenTemplateIds.includes(t.templateId))
  }, [templates, hiddenTemplateIds, showHidden])

  // Prune stale hidden IDs that no longer exist in current template set
  useEffect(() => {
    if (templates.length === 0 || hiddenTemplateIds.length === 0) return
    const currentIds = new Set(templates.map((t) => t.templateId))
    const stale = hiddenTemplateIds.filter((id) => !currentIds.has(id))
    if (stale.length > 0) {
      for (const id of stale) toggleHideTemplate(id)
    }
  }, [templates, hiddenTemplateIds, toggleHideTemplate])

  const hiddenCount = useMemo(
    () => templates.filter((t) => hiddenTemplateIds.includes(t.templateId)).length,
    [templates, hiddenTemplateIds],
  )

  const getSparklinePoints = useCallback(
    (templateId: string): number[] => sparklineRef.current[templateId]?.map((p) => p.count) ?? [],
    [],
  )

  const columns = useMemo(
    () => [
      columnHelper.accessor('templateText', {
        header: 'Template',
        size: 400,
        cell: (info) => (
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-xs text-text-primary truncate">{info.getValue()}</span>
            {info.row.original.isNewToday && <Badge variant="new">new</Badge>}
          </div>
        ),
      }),
      columnHelper.accessor('service', {
        header: 'Service',
        size: 140,
        cell: (info) => <span className="text-xs text-text-secondary">{info.getValue()}</span>,
      }),
      columnHelper.accessor('occurrenceCount', {
        header: 'Count',
        size: 100,
        cell: (info) => (
          <span className="font-mono text-xs tabular-nums text-text-primary">
            {info.getValue().toLocaleString()}
          </span>
        ),
      }),
      columnHelper.accessor('errorCount', {
        header: 'Errors',
        size: 80,
        cell: (info) => {
          const val = info.getValue()
          return (
            <span
              className={cn(
                'font-mono text-xs tabular-nums',
                val > 0 ? 'text-danger' : 'text-text-muted',
              )}
            >
              {val.toLocaleString()}
            </span>
          )
        },
      }),
      columnHelper.display({
        id: 'trend',
        header: () => (
          <span className="flex items-center gap-1">
            Trend <InfoTooltip content={TOOLTIPS.trendColumn} />
          </span>
        ),
        size: 100,
        cell: (info) => {
          const points = getSparklinePoints(info.row.original.templateId)
          return <MiniSparkline points={points} />
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        size: 36,
        cell: (info) => {
          const id = info.row.original.templateId
          const isHidden = hiddenTemplateIds.includes(id)
          return (
            <button
              type="button"
              title={isHidden ? 'Unhide pattern' : 'Hide pattern'}
              className={cn(
                'p-1 rounded transition-colors',
                isHidden
                  ? 'text-warning hover:text-text-primary'
                  : 'text-transparent group-hover/row:text-text-muted hover:text-text-primary',
              )}
              onClick={(e) => {
                e.stopPropagation()
                toggleHideTemplate(id)
              }}
            >
              {isHidden ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          )
        },
      }),
    ],
    [getSparklinePoints, hiddenTemplateIds, toggleHideTemplate],
  )
  const [sorting, setSorting] = useState<SortingState>([{ id: 'occurrenceCount', desc: true }])
  const [globalFilter, setGlobalFilter] = useState('')
  const parentRef = useRef<HTMLDivElement>(null)

  const table = useReactTable({
    data: visibleTemplates,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = String(filterValue).toLowerCase()
      return (
        row.original.templateText.toLowerCase().includes(search) ||
        row.original.service.toLowerCase().includes(search)
      )
    },
  })

  const { rows } = table.getRowModel()

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 3,
  })

  if (isLoading) {
    return (
      <Card className={cn(className)}>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((id) => (
              <Skeleton key={id} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <CardTitle>Patterns ({visibleTemplates.length})</CardTitle>
            {hiddenCount > 0 && (
              <>
                <button
                  type="button"
                  onClick={toggleShowHidden}
                  className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border transition-colors',
                    showHidden
                      ? 'bg-brand-500/10 text-brand-400 border-brand-500/20'
                      : 'bg-surface-elevated text-text-muted border-border-subtle hover:text-text-secondary',
                  )}
                >
                  {showHidden ? <Eye size={11} /> : <EyeOff size={11} />}
                  {hiddenCount} hidden
                </button>
                <button
                  type="button"
                  onClick={unhideAllTemplates}
                  className="px-2 py-0.5 text-[11px] font-medium text-text-muted hover:text-text-secondary transition-colors"
                >
                  Show all
                </button>
              </>
            )}
            {templates.length > 0 && hiddenCount < templates.length && (
              <button
                type="button"
                onClick={() => hideAllTemplates(templates.map((t) => t.templateId))}
                className="px-2 py-0.5 text-[11px] font-medium text-text-muted hover:text-text-secondary transition-colors"
              >
                Hide all
              </button>
            )}
          </div>
          <div className="relative w-64">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <Input
              placeholder="Search templates..."
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="pl-8"
              aria-label="Search templates"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Table header */}
        <div className="flex items-center border-b border-border-subtle pb-2 mb-1">
          {table.getHeaderGroups().map((headerGroup) =>
            headerGroup.headers.map((header) => {
              const sorted = header.column.getIsSorted()
              const ariaSortValue =
                sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'
              return (
                <div
                  key={header.id}
                  style={{ width: header.getSize() }}
                  className={cn(
                    'shrink-0 text-[11px] font-medium text-text-muted uppercase tracking-wider',
                    header.column.getCanSort() &&
                      'cursor-pointer select-none hover:text-text-secondary',
                  )}
                >
                  {header.column.getCanSort() ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 uppercase tracking-wider"
                      aria-label={`Sort by ${typeof header.column.columnDef.header === 'string' ? header.column.columnDef.header : header.id}, currently ${ariaSortValue}`}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {sorted === 'asc' && '\u2191'}
                      {sorted === 'desc' && '\u2193'}
                    </button>
                  ) : (
                    <span className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </span>
                  )}
                </div>
              )
            }),
          )}
        </div>

        {/* Virtual scrolling body */}
        <div ref={parentRef} className="overflow-auto" style={{ maxHeight: '500px' }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (!row) return null
              const isSelected = row.original.templateId === selectedTemplateId
              return (
                <div
                  key={row.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {/* biome-ignore lint/a11y/useSemanticElements: can't use <button> — contains nested interactive hide button */}
                  <div
                    role="button"
                    className={cn(
                      'group/row flex items-center w-full py-2 border-b border-border-subtle/50 cursor-pointer transition-colors text-left',
                      isSelected
                        ? 'bg-brand-500/10 border-l-2 border-l-brand-500'
                        : 'hover:bg-surface-elevated/50',
                      showHidden &&
                        hiddenTemplateIds.includes(row.original.templateId) &&
                        'opacity-50',
                    )}
                    tabIndex={0}
                    onClick={() => setSelectedTemplateId(row.original.templateId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedTemplateId(row.original.templateId)
                      }
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        style={{ width: cell.column.getSize() }}
                        className="shrink-0 px-1"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {rows.length === 0 && (
          <div className="py-12 text-center text-text-muted text-sm">
            {globalFilter
              ? 'No patterns match your search.'
              : hiddenCount > 0 && hiddenCount >= templates.length
                ? `All ${hiddenCount} patterns are hidden. Click "hidden" above to reveal them.`
                : 'No template data available.'}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
