import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { queryKeys } from '../../api/query-keys'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api-client'
import { cn } from '../../lib/cn'

interface StepClusteringProps {
  complete: boolean
}

const presets = [
  {
    id: 'specific',
    label: 'More specific',
    value: 0.3,
    description: 'Treats small differences as separate patterns',
    example: '"Login failed for user alice" \u2260 "Login failed for user bob"',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    value: 0.4,
    description: 'Groups similar messages, keeps meaningful differences',
    example: '"Login failed for user <*>" (recommended)',
    recommended: true,
  },
  {
    id: 'general',
    label: 'More general',
    value: 0.6,
    description: 'Maximum compression, may lose important distinctions',
    example: '"Login <*>"',
  },
] as const

export function StepClustering({ complete }: StepClusteringProps) {
  const [selected, setSelected] = useState<string>('balanced')
  const queryClient = useQueryClient()

  const saveMutation = useMutation({
    mutationFn: (sensitivity: number) =>
      api.put('/v1/settings/clustering', { sensitivity }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.onboardingStatus() })
      toast.success('Clustering sensitivity saved')
    },
    onError: () => toast.error('Failed to save clustering sensitivity'),
  })

  if (complete) {
    return (
      <div className="flex items-center gap-2 text-success-500 text-sm">
        <Check size={16} />
        <span>Clustering sensitivity configured!</span>
      </div>
    )
  }

  const handleApply = () => {
    const preset = presets.find((p) => p.id === selected)
    if (preset) saveMutation.mutate(preset.value)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">
        How should LogWeave group your log patterns?
      </p>

      <div className="space-y-2">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => setSelected(preset.id)}
            className={cn(
              'w-full text-left rounded-[var(--radius-md)] border p-3 transition-colors',
              selected === preset.id
                ? 'border-brand-400 bg-brand-500/5'
                : 'border-border-subtle hover:border-border hover:bg-surface-elevated',
            )}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <div
                className={cn(
                  'h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center shrink-0',
                  selected === preset.id ? 'border-brand-400' : 'border-text-muted',
                )}
              >
                {selected === preset.id && (
                  <div className="h-1.5 w-1.5 rounded-full bg-brand-400" />
                )}
              </div>
              <span className="text-sm font-medium text-text-primary">{preset.label}</span>
              {'recommended' in preset && preset.recommended && (
                <span className="text-[10px] bg-brand-500/10 text-brand-400 px-1.5 py-0.5 rounded-full">
                  recommended
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted ml-5.5 pl-0.5">{preset.description}</p>
            <p className="text-xs text-text-disabled ml-5.5 pl-0.5 font-mono mt-0.5">{preset.example}</p>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          onClick={handleApply}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? 'Applying...' : 'Apply'}
        </Button>
        <button
          type="button"
          onClick={() => {
            // Apply the default (balanced = 0.4) silently
            saveMutation.mutate(0.4)
          }}
          className="text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          Skip — use default
        </button>
      </div>

      <p className="text-[10px] text-text-disabled">
        You can change this anytime in Settings.
      </p>
    </div>
  )
}
