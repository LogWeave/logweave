export const config = {
  apiUrl: import.meta.env.VITE_LOGWEAVE_API_URL ?? '',
  apiKey: import.meta.env.VITE_LOGWEAVE_API_KEY ?? '',
  pollIntervalMs: Number(import.meta.env.VITE_POLL_INTERVAL_MS || 60_000),
  staleTimeMs: 30_000,
  fetchTimeoutMs: 10_000,
} as const
