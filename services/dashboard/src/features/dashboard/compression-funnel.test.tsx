import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClusteringHealthData } from '../../api/types'
import { render, screen } from '../../test/test-utils'
import { CompressionFunnel } from './compression-funnel'

// Mock the data hook so the test drives the component purely off health inputs
// and exercises the inline ratio / percentage math.
const useClusteringHealth = vi.fn()
vi.mock('../../api/queries', () => ({
  useClusteringHealth: () => useClusteringHealth(),
}))

function health(overrides: Partial<ClusteringHealthData> = {}): ClusteringHealthData {
  return {
    totalEvents: 10_000,
    clusteredEvents: 9_500,
    unclusteredEvents: 0,
    uniqueTemplates: 500,
    compressionRatio: 20,
    trend: [],
    ...overrides,
  }
}

function mockHealth(data: ClusteringHealthData | undefined, isLoading = false) {
  useClusteringHealth.mockReturnValue({ data: data ? { data } : undefined, isLoading })
}

afterEach(() => {
  useClusteringHealth.mockReset()
})

describe('CompressionFunnel', () => {
  it('renders the compression ratio as events:templates rounded', () => {
    mockHealth(health({ totalEvents: 10_000, uniqueTemplates: 500 }))
    render(<CompressionFunnel />)
    expect(screen.getByText('20:1 ratio')).toBeInTheDocument()
  })

  it('rounds a non-integer ratio', () => {
    // 10000 / 333 = 30.03 -> 30
    mockHealth(health({ totalEvents: 10_000, uniqueTemplates: 333 }))
    render(<CompressionFunnel />)
    expect(screen.getByText('30:1 ratio')).toBeInTheDocument()
  })

  it('formats large counts with thousands separators', () => {
    mockHealth(health({ totalEvents: 1_234_567, uniqueTemplates: 1000 }))
    render(<CompressionFunnel />)
    expect(screen.getByText('1,234,567')).toBeInTheDocument()
    expect(screen.getByText('1,000')).toBeInTheDocument()
  })

  it('shows the unclustered indicator only when there are unclustered events', () => {
    mockHealth(health({ unclusteredEvents: 42 }))
    const { unmount } = render(<CompressionFunnel />)
    expect(screen.getByText(/42 unclustered/)).toBeInTheDocument()
    unmount()

    mockHealth(health({ unclusteredEvents: 0 }))
    render(<CompressionFunnel />)
    expect(screen.queryByText(/unclustered/)).not.toBeInTheDocument()
  })

  it('renders nothing when there are zero total events', () => {
    mockHealth(health({ totalEvents: 0 }))
    const { container } = render(<CompressionFunnel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when health data is absent', () => {
    mockHealth(undefined)
    const { container } = render(<CompressionFunnel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a skeleton while loading', () => {
    mockHealth(undefined, true)
    const { container } = render(<CompressionFunnel />)
    // Loading state renders a skeleton placeholder, not the funnel content.
    expect(container.firstChild).not.toBeNull()
    expect(screen.queryByText(/ratio/)).not.toBeInTheDocument()
  })
})
