import { z } from 'zod'

export const costAnalysisSchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  service: z.string().min(1).max(256).optional(),
  level: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
})

export type CostAnalysisQuery = z.infer<typeof costAnalysisSchema>

export type Classification = 'noise' | 'review'

export interface CostPattern {
  templateId: string
  template: string
  service: string
  level: string
  count: number
  volumePct: number
  classification: Classification
  suggestion: string
}

export interface CostAnalysisSummary {
  totalPatternsAnalyzed: number
  noiseCount: number
  reviewCount: number
  keepCount: number
  potentialReductionPct: number
}

export interface CostThresholds {
  noiseDebugPct: number
  reviewInfoPct: number
  reviewWarnPct: number
}

export interface CostAnalysisData {
  summary: CostAnalysisSummary
  patterns: CostPattern[]
  thresholds: CostThresholds
}
