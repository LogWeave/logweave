/** Discriminated union for value generators */
export type GeneratorConfig =
  | { type: 'choice'; values: unknown[] }
  | { type: 'weighted_choice'; values: Array<{ value: unknown; weight: number }> }
  | { type: 'int'; min: number; max: number }
  | { type: 'float'; min: number; max: number; decimals?: number }
  | { type: 'uuid' }
  | { type: 'ip' }
  | { type: 'email' }
  | { type: 'sequence'; prefix: string; start?: number }
  | { type: 'timestamp' }

/** A single log template with message pattern, level, and optional generators */
export interface TemplateConfig {
  /** Message template with {{placeholder}} syntax, e.g. "Payment for {{orderId}}" */
  message: string
  /** Log level: info, warn, error, debug, fatal */
  level: string
  /** Relative weight for random selection (default 1) */
  weight?: number
  /** Static or $gen-driven fields attached to the event */
  fields?: Record<string, unknown>
  /** Template-scoped generators (override service-level) */
  generators?: Record<string, GeneratorConfig>
}

/** Deploy-spike configuration */
export interface SpikeConfig {
  /** Extra templates injected during spike mode */
  extra_templates?: TemplateConfig[]
  /** Multiplier for error/fatal template weights (default 3) */
  error_weight_multiplier?: number
}

/** Service config — one JSON file per service */
export interface ServiceConfig {
  service: string
  environment?: string
  metadata?: Record<string, unknown>
  generators?: Record<string, GeneratorConfig>
  templates: TemplateConfig[]
  spike?: SpikeConfig
}

/** Global defaults config */
export interface DefaultsConfig {
  rate: number
  buffer_size: number
  flush_interval_ms: number
  mode: Mode
  mode_timings: {
    spike_duration_seconds: number
    storm_duration_seconds: number
    quiet_duration_seconds: number
    chaos_steady_min_seconds: number
    chaos_steady_max_seconds: number
  }
}

export type Mode = 'steady' | 'deploy-spike' | 'error-storm' | 'quiet' | 'chaos'

export interface CliOptions {
  rate: number
  services: string[]
  mode: Mode
  duration: number
  apiKey: string
  endpoint: string
  bufferSize: number
  flushMs: number
  dryRun: boolean
  /** Tracks which flags were explicitly provided (vs defaults) */
  _explicit: {
    rate: boolean
    bufferSize: boolean
    flushMs: boolean
  }
}
