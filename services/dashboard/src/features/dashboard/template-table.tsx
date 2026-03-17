import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTemplates } from '../../api/queries'
import type { TemplateRow } from '../../api/types'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import { TemplateRowDetail } from './template-row-detail'

const columnHelper = createColumnHelper<TemplateRow>()

const columns = [
  columnHelper.display({
    id: 'expand',
    size: 32,
    cell: ({ row }) => (
      <button
        type="button"
        onClick={row.getToggleExpandedHandler()}
        className="p-1 text-text-muted hover:text-text-primary transition-colors"
      >
        {row.getIsExpanded() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
    ),
  }),
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
  columnHelper.accessor('maxAnomalyScore', {
    header: 'Anomaly',
    size: 80,
    cell: (info) => {
      const val = info.getValue()
      return (
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            val > 1 ? 'text-danger' : val > 0.5 ? 'text-warning' : 'text-text-muted',
          )}
        >
          {val.toFixed(2)}
        </span>
      )
    },
  }),
]

export function TemplateTable({ className }: { className?: string }) {
  const { data: response, isLoading } = useTemplates()
  const templates = response?.data ?? []
  const [sorting, setSorting] = useState<SortingState>([{ id: 'occurrenceCount', desc: true }])
  const [globalFilter, setGlobalFilter] = useState('')
  const parentRef = useRef<HTMLDivElement>(null)

  const table = useReactTable({
    data: templates,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
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
    overscan: 10,
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
          <CardTitle>Templates ({templates.length})</CardTitle>
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
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Table header */}
        <div className="flex items-center border-b border-border-subtle pb-2 mb-1">
          {table.getHeaderGroups().map((headerGroup) =>
            headerGroup.headers.map((header) => (
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
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {header.column.getIsSorted() === 'asc' && '\u2191'}
                    {header.column.getIsSorted() === 'desc' && '\u2193'}
                  </button>
                ) : (
                  <span className="flex items-center gap-1">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </span>
                )}
              </div>
            )),
          )}
        </div>

        {/* Virtual scrolling body */}
        <div ref={parentRef} className="overflow-auto" style={{ maxHeight: '500px' }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (!row) return null
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
                  <div
                    className={cn(
                      'flex items-center py-2 border-b border-border-subtle/50 hover:bg-surface-elevated/50 transition-colors',
                      row.getIsExpanded() && 'bg-surface-elevated/30',
                    )}
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
                  {row.getIsExpanded() && <TemplateRowDetail template={row.original} />}
                </div>
              )
            })}
          </div>
        </div>

        {rows.length === 0 && (
          <div className="py-12 text-center text-text-muted text-sm">
            {globalFilter ? 'No templates match your search.' : 'No template data available.'}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
