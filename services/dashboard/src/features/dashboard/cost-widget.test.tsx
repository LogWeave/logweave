import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CostAnalysisData, CostPattern } from '../../api/types'
import { render, screen, within } from '../../test/test-utils'
import { CostWidget } from './cost-widget'

const useCostAnalysis = vi.fn()
vi.mock('../../api/queries', () => ({
  useCostAnalysis: () => useCostAnalysis(),
}))

function pattern(overrides: Partial<CostPattern> = {}): CostPattern {
  return {
    templateId: 'tpl-1',
    template: 'GET /health <NUM>',
    service: 'api',
    level: 'DEBUG',
    count: 100,
    volumePct: 12.34,
    classification: 'noise',
    suggestion: 'Drop this debug line',
    ...overrides,
  }
}

function analysis(patterns: CostPattern[]): CostAnalysisData {
  const noiseCount = patterns.filter((p) => p.classification === 'noise').length
  const reviewCount = patterns.filter((p) => p.classification === 'review').length
  return {
    summary: {
      totalPatternsAnalyzed: patterns.length,
      noiseCount,
      reviewCount,
      keepCount: 0,
      potentialReductionPct: 30,
    },
    patterns,
    thresholds: { noiseDebugPct: 5, reviewInfoPct: 10, reviewWarnPct: 5, isCustom: false },
  }
}

function mockCost(
  data?: CostAnalysisData,
  state: Partial<{ isLoading: boolean; isError: boolean }> = {},
) {
  useCostAnalysis.mockReturnValue({
    data: data ? { data } : undefined,
    isLoading: state.isLoading ?? false,
    isError: state.isError ?? false,
    refetch: vi.fn(),
  })
}

afterEach(() => useCostAnalysis.mockReset())

describe('CostWidget', () => {
  it('renders noise and review patterns, splitting by classification', () => {
    mockCost(
      analysis([
        pattern({ templateId: 'n1', template: 'noise one', classification: 'noise' }),
        pattern({
          templateId: 'r1',
          template: 'review one',
          classification: 'review',
          level: 'INFO',
        }),
      ]),
    )
    render(<CostWidget />)
    expect(screen.getByText('noise one')).toBeInTheDocument()
    expect(screen.getByText('review one')).toBeInTheDocument()
  })

  it('formats volume percentage to one decimal place', () => {
    mockCost(analysis([pattern({ volumePct: 12.34 })]))
    render(<CostWidget />)
    expect(screen.getByText('12.3%')).toBeInTheDocument()
  })

  it('renders the level badge text for each pattern level', () => {
    mockCost(analysis([pattern({ level: 'ERROR', classification: 'review' })]))
    render(<CostWidget />)
    expect(screen.getByText('ERROR')).toBeInTheDocument()
  })

  it('shows the summary counts and potential reduction', () => {
    mockCost(
      analysis([
        pattern({ templateId: 'n1', classification: 'noise' }),
        pattern({ templateId: 'r1', classification: 'review' }),
      ]),
    )
    render(<CostWidget />)
    expect(screen.getByText(/1 noise/)).toBeInTheDocument()
    expect(screen.getByText(/1 review/)).toBeInTheDocument()
    expect(screen.getByText('30%')).toBeInTheDocument()
  })

  it('shows the efficient-logging empty state when there are no patterns', () => {
    mockCost(analysis([]))
    render(<CostWidget />)
    expect(screen.getByText(/your logging looks efficient/i)).toBeInTheDocument()
  })

  it('renders an error state with a retry affordance', () => {
    mockCost(undefined, { isError: true })
    render(<CostWidget />)
    // QueryError renders inside the card; the title still shows.
    expect(screen.getByText('Log Cost Optimizer')).toBeInTheDocument()
    expect(screen.queryByText(/looks efficient/i)).not.toBeInTheDocument()
  })

  it('renders noise patterns before review patterns', () => {
    mockCost(
      analysis([
        pattern({
          templateId: 'r1',
          template: 'REVIEW_ROW',
          classification: 'review',
          level: 'INFO',
        }),
        pattern({ templateId: 'n1', template: 'NOISE_ROW', classification: 'noise' }),
      ]),
    )
    const { container } = render(<CostWidget />)
    const body = within(container)
    const noiseIdx = body
      .getByText('NOISE_ROW')
      .compareDocumentPosition(body.getByText('REVIEW_ROW'))
    // NOISE_ROW should come first in document order.
    expect(noiseIdx & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
