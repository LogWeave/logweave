import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// React Testing Library does not auto-clean between tests when globals are on
// for every runner; do it explicitly so mounted trees never leak across cases.
afterEach(() => {
  cleanup()
})

// jsdom has no matchMedia; several UI components (theme, responsive) read it.
vi.stubGlobal(
  'matchMedia',
  vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
)

// jsdom lacks ResizeObserver; ECharts and virtualized tables construct one.
vi.stubGlobal(
  'ResizeObserver',
  vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  })),
)
