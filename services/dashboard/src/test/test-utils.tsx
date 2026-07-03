import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderOptions, type RenderResult, render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * A QueryClient tuned for tests: no retries (failures surface immediately) and
 * no background refetching (deterministic single fetch per query). Build a fresh
 * one per render so cache never bleeds between test cases.
 */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
}

interface WrapperOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial history entries for the router. Defaults to ['/']. */
  routes?: string[]
  /** Reuse an existing client (e.g. to prime the cache before rendering). */
  queryClient?: QueryClient
}

/**
 * Render a component inside the app's real providers (React Query + Router).
 * Returns the render result plus the QueryClient so tests can seed or inspect
 * cache state.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: WrapperOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const { routes = ['/'], queryClient = makeTestQueryClient(), ...rest } = options

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={routes}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper, ...rest }) }
}

// Re-export the RTL surface so test files import everything from one place.
export * from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'
