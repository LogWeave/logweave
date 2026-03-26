/**
 * Query key factory — single source of truth for all React Query keys.
 * Prevents key drift across hooks and makes invalidation predictable.
 */
export const queryKeys = {
  overview: (hours: number, levels: string) => ['dashboard', 'overview', hours, levels] as const,
  volume: (hours: number, service: string | null, levels: string) =>
    ['dashboard', 'volume', hours, service, levels] as const,
  services: (hours: number, levels: string) => ['dashboard', 'services', hours, levels] as const,
  templates: (hours: number, service: string | null, levels: string) =>
    ['dashboard', 'templates', hours, service, levels] as const,
  sparklines: (hours: number, ids: string, levels: string) =>
    ['dashboard', 'sparklines', hours, ids, levels] as const,
  clusteringHealth: (hours: number, levels: string) =>
    ['dashboard', 'clustering-health', hours, levels] as const,
  changes: (hours: number, service: string | null, levels: string) =>
    ['dashboard', 'changes', hours, service, levels] as const,
  levels: (hours: number, service: string | null) =>
    ['dashboard', 'levels', hours, service] as const,
  templateStatusCodes: (hours: number, templateId: string | null, since?: string, until?: string) =>
    ['dashboard', 'template-status-codes', hours, templateId, since, until] as const,
  templateEvents: (templateId: string, hours: number, statusCode?: number) =>
    ['dashboard', 'template-events', templateId, hours, statusCode] as const,
  deploys: (limit: number) => ['deploys', limit] as const,
  watches: () => ['watches'] as const,
  rules: () => ['rules'] as const,
  alerts: (hours: number) => ['alerts', hours] as const,
  slackSettings: () => ['settings', 'slack'] as const,
  tagSettings: () => ['settings', 'tags'] as const,
  onboardingStatus: () => ['settings', 'onboarding'] as const,
  costAnalysis: (hours: number, service: string | null) => ['cost', 'analysis', hours, service] as const,
  costThresholds: () => ['settings', 'cost-thresholds'] as const,
} as const

/** Convert level filter array to stable query param string. */
export function levelParam(filters: string[]): string {
  return filters.length > 0 ? filters.join(',') : ''
}

/** Convert level filter array to API param (undefined when empty). */
export function levelApiParam(filters: string[]): string | undefined {
  return filters.length > 0 ? filters.join(',') : undefined
}
