/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOGWEAVE_API_URL: string
  readonly VITE_LOGWEAVE_API_KEY: string
  readonly VITE_POLL_INTERVAL_MS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
