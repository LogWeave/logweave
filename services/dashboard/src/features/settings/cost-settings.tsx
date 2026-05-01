import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useCostThresholds, useSaveCostThresholds, useSpikeBaseline, useSaveSpikeBaseline } from '../../api/queries'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/cn'

export function SpikeBaselineSettings() {
  const { data: baselineResponse } = useSpikeBaseline()
  const baseline = baselineResponse?.data
  const saveMutation = useSaveSpikeBaseline()

  const [minBaseline, setMinBaseline] = useState(10)

  useEffect(() => {
    if (baseline) {
      setMinBaseline(baseline.minBaseline)
    }
  }, [baseline])

  const handleSave = () => {
    if (minBaseline < 0) {
      toast.error('Minimum baseline must be non-negative')
      return
    }
    saveMutation.mutate(minBaseline, {
      onSuccess: () => toast.success('Spike baseline saved'),
      onError: () => toast.error('Failed to save spike baseline'),
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>What Changed — Spike Minimum Baseline</CardTitle>
          <span
            className={cn(
              'text-[11px] font-medium px-2 py-0.5 rounded-full',
              baseline?.isCustom
                ? 'bg-brand-500/10 text-brand-400'
                : 'bg-surface-elevated text-text-muted',
            )}
          >
            {baseline?.isCustom ? 'Custom' : 'Using defaults'}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-xs text-text-muted">
            Spikes are only surfaced when the pattern had at least this many events in the
            previous window. Suppresses 0→1 noise without hiding genuine traffic spikes.
          </p>
          <div className="space-y-1">
            <label className="text-xs text-text-secondary font-medium">
              Minimum previous-window count
            </label>
            <p className="text-[10px] text-text-muted">
              Patterns with fewer events than this in the prior window are excluded from spikes. Default: 10
            </p>
            <Input
              type="number"
              min={0}
              max={10000}
              step={1}
              value={minBaseline}
              onChange={(e) => setMinBaseline(Number(e.target.value))}
              className="max-w-[120px]"
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={handleSave}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save Baseline'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function CostSettings() {
  const { data: thresholdsResponse } = useCostThresholds()
  const thresholds = thresholdsResponse?.data
  const saveMutation = useSaveCostThresholds()

  const [noiseDebugPct, setNoiseDebugPct] = useState(5)
  const [reviewInfoPct, setReviewInfoPct] = useState(10)
  const [reviewWarnPct, setReviewWarnPct] = useState(20)

  // Sync form state with server values
  useEffect(() => {
    if (thresholds) {
      setNoiseDebugPct(thresholds.noiseDebugPct)
      setReviewInfoPct(thresholds.reviewInfoPct)
      setReviewWarnPct(thresholds.reviewWarnPct)
    }
  }, [thresholds])

  const handleSave = () => {
    if (noiseDebugPct < 0 || reviewInfoPct < 0 || reviewWarnPct < 0) {
      toast.error('Threshold values must be non-negative')
      return
    }
    saveMutation.mutate(
      { noiseDebugPct, reviewInfoPct, reviewWarnPct },
      {
        onSuccess: () => toast.success('Cost optimizer thresholds saved'),
        onError: () => toast.error('Failed to save thresholds'),
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Cost Optimizer Thresholds</CardTitle>
          <span
            className={cn(
              'text-[11px] font-medium px-2 py-0.5 rounded-full',
              thresholds?.isCustom
                ? 'bg-brand-500/10 text-brand-400'
                : 'bg-surface-elevated text-text-muted',
            )}
          >
            {thresholds?.isCustom ? 'Custom' : 'Using defaults'}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-xs text-text-muted">
            Control how the cost optimizer classifies log patterns. Patterns below the threshold
            percentage for their level are flagged for optimization.
          </p>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-text-secondary font-medium">
                Noise threshold (DEBUG/TRACE)
              </label>
              <p className="text-[10px] text-text-muted">
                DEBUG/TRACE patterns above this volume percentage are classified as noise. Default: 5
              </p>
              <Input
                type="number"
                min={0}
                max={100}
                step={1}
                value={noiseDebugPct}
                onChange={(e) => setNoiseDebugPct(Number(e.target.value))}
                className="max-w-[120px]"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-text-secondary font-medium">
                Review threshold (INFO)
              </label>
              <p className="text-[10px] text-text-muted">
                INFO patterns above this volume percentage are flagged for review. Default: 10
              </p>
              <Input
                type="number"
                min={0}
                max={100}
                step={1}
                value={reviewInfoPct}
                onChange={(e) => setReviewInfoPct(Number(e.target.value))}
                className="max-w-[120px]"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-text-secondary font-medium">
                Review threshold (WARN)
              </label>
              <p className="text-[10px] text-text-muted">
                WARN patterns above this volume percentage are flagged for review. Default: 20
              </p>
              <Input
                type="number"
                min={0}
                max={100}
                step={1}
                value={reviewWarnPct}
                onChange={(e) => setReviewWarnPct(Number(e.target.value))}
                className="max-w-[120px]"
              />
            </div>
          </div>

          <Button
            size="sm"
            variant="primary"
            onClick={handleSave}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save Thresholds'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
