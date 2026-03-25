import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../api/query-keys'
import type { ApiResponse, OnboardingStatus } from '../../api/types'
import { api } from '../../lib/api-client'

export function useOnboardingStatus() {
  return useQuery({
    queryKey: queryKeys.onboardingStatus(),
    queryFn: () => api.get<ApiResponse<OnboardingStatus>>('/v1/settings/onboarding-status'),
    staleTime: 10_000,
  })
}

export function useDismissOnboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post('/v1/settings/onboarding/dismiss'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.onboardingStatus() })
    },
  })
}

/** Count of incomplete onboarding steps (0-2, clustering excluded for now). */
export function useOnboardingRemaining(status: OnboardingStatus | undefined): number {
  if (!status) return 0
  let remaining = 0
  if (!status.hasEvents) remaining++
  if (!status.mcpConnected) remaining++
  return remaining
}
