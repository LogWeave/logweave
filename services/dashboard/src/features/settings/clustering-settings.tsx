import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { queryKeys } from '../../api/query-keys'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { api } from '../../lib/api-client'
import { cn } from '../../lib/cn'

interface ClusteringData {
  sensitivity: number | null
}

interface PreviewData {
  patternCount: number
  compressionRatio: number
  sampleTemplates: string[]
}

interface ApiResponse<T> {
  data: T
  meta: Record<string, unknown>
}

const PRESETS = [
  { value: 0.2, label: 'Very Specific' },
  { value: 0.3, label: 'Specific' },
  { value: 0.4, label: 'Balanced' },
  { value: 0.5, label: 'General' },
  { value: 0.6, label: 'Very General' },
  { value: 0.7, label: 'Broad' },
  { value: 0.8, label: 'Maximum' },
]

function sensitivityLabel(value: number): string {
  const preset = PRESETS.find((p) => p.value === value)
  if (preset) return preset.label
  if (value < 0.35) return 'Specific'
  if (value < 0.55) return 'Balanced'
  return 'General'
}

export function ClusteringSettings() {
  const queryClient = useQueryClient()

  const { data: clusteringResponse } = useQuery({
    queryKey: ['settings', 'clustering'],
    queryFn: () => api.get<ApiResponse<ClusteringData>>('/v1/settings/clustering'),
    staleTime: 30_000,
  })

  const currentSensitivity = clusteringResponse?.data.sensitivity ?? 0.4
  const [sliderValue, setSliderValue] = useState(currentSensitivity)
  const [showConfirm, setShowConfirm] = useState(false)

  // Sync slider with server value
  useEffect(() => {
    if (clusteringResponse?.data.sensitivity !== null && clusteringResponse?.data.sensitivity !== undefined) {
      setSliderValue(clusteringResponse.data.sensitivity)
    }
  }, [clusteringResponse?.data.sensitivity])

  // Preview query — debounced via enabled flag
  const [previewSensitivity, setPreviewSensitivity] = useState<number | null>(null)

  const { data: previewResponse, isFetching: previewLoading } = useQuery({
    queryKey: ['settings', 'clustering-preview', previewSensitivity],
    queryFn: () =>
      api.post<ApiResponse<PreviewData>>('/v1/settings/clustering/preview', {
        sensitivity: previewSensitivity,
      }),
    enabled: previewSensitivity !== null,
    staleTime: 60_000,
  })

  // Debounce preview requests
  useEffect(() => {
    const timer = setTimeout(() => {
      setPreviewSensitivity(sliderValue)
    }, 500)
    return () => clearTimeout(timer)
  }, [sliderValue])

  const preview = previewResponse?.data

  const saveMutation = useMutation({
    mutationFn: (sensitivity: number) => api.put('/v1/settings/clustering', { sensitivity }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'clustering'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.onboardingStatus() })
      toast.success('Clustering sensitivity saved — applies to new logs')
    },
    onError: () => toast.error('Failed to save sensitivity'),
  })

  const resetMutation = useMutation({
    mutationFn: (sensitivity: number) =>
      api.post('/v1/settings/clustering/reset', { sensitivity }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'clustering'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.onboardingStatus() })
      setShowConfirm(false)
      toast.success('Clustering reset — patterns will be relearned from incoming logs')
    },
    onError: () => toast.error('Failed to reset clustering'),
  })

  const handleApply = useCallback(() => {
    saveMutation.mutate(sliderValue)
  }, [sliderValue, saveMutation])

  const handleReset = useCallback(() => {
    resetMutation.mutate(sliderValue)
  }, [sliderValue, resetMutation])

  const isConfigured = clusteringResponse?.data.sensitivity !== null && clusteringResponse?.data.sensitivity !== undefined

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Clustering Sensitivity</CardTitle>
          <span
            className={cn(
              'text-[11px] font-medium px-2 py-0.5 rounded-full',
              isConfigured ? 'bg-brand-500/10 text-brand-400' : 'bg-surface-elevated text-text-muted',
            )}
          >
            {isConfigured ? sensitivityLabel(currentSensitivity) : 'Default (0.4)'}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-xs text-text-muted">
            Control how LogWeave groups your log messages into patterns. More specific = more
            patterns with finer distinctions. More general = fewer patterns, broader grouping.
          </p>

          {/* Slider */}
          <div className="space-y-2">
            <div className="flex justify-between text-[10px] text-text-muted">
              <span>More Specific</span>
              <span>More General</span>
            </div>
            <input
              type="range"
              min={0.2}
              max={0.8}
              step={0.05}
              value={sliderValue}
              onChange={(e) => setSliderValue(Number(e.target.value))}
              className="w-full accent-brand-500"
            />
            <div className="flex justify-between items-center">
              <span className="text-xs text-text-secondary font-mono">{sliderValue.toFixed(2)}</span>
              <span className="text-xs text-text-muted">{sensitivityLabel(sliderValue)}</span>
            </div>
          </div>

          {/* Preview card */}
          {preview && (
            <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-base p-3 space-y-2">
              <div className="flex gap-4 text-xs">
                <div>
                  <span className="text-text-muted">Patterns: </span>
                  <span className="text-text-primary font-medium">{preview.patternCount}</span>
                </div>
                <div>
                  <span className="text-text-muted">Compression: </span>
                  <span className="text-text-primary font-medium">{preview.compressionRatio}:1</span>
                </div>
                <div>
                  <span className="text-text-muted">Sample: </span>
                  <span className="text-text-primary font-medium">
                    {String(previewResponse?.meta?.sampleSize ?? 0)} logs
                  </span>
                </div>
              </div>
              {preview.sampleTemplates.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] text-text-muted">Top patterns:</p>
                  {preview.sampleTemplates.slice(0, 5).map((tmpl, i) => (
                    <div
                      key={i}
                      className="text-[11px] font-mono text-text-secondary truncate bg-surface-card rounded px-2 py-1"
                    >
                      {tmpl}
                    </div>
                  ))}
                </div>
              )}
              {previewLoading && (
                <p className="text-[10px] text-text-muted animate-pulse">Updating preview...</p>
              )}
            </div>
          )}

          {!preview && previewLoading && (
            <div className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-base p-3">
              <p className="text-xs text-text-muted animate-pulse">Loading preview...</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={handleApply}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Applying...' : 'Apply to new logs'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowConfirm(true)}
              disabled={resetMutation.isPending}
            >
              Reset &amp; relearn
            </Button>
          </div>

          {/* Confirmation dialog */}
          {showConfirm && (
            <div className="rounded-[var(--radius-md)] border border-warning-500/30 bg-warning-500/5 p-3 space-y-2">
              <p className="text-xs text-text-primary font-medium">Reset pattern recognition?</p>
              <p className="text-xs text-text-muted">
                This resets pattern recognition. Your log data and history are not affected. New
                patterns will be learned from incoming logs within minutes.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={handleReset} disabled={resetMutation.isPending}>
                  {resetMutation.isPending ? 'Resetting...' : 'Confirm reset'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowConfirm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
