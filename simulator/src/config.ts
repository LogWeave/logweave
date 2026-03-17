import fs from 'node:fs'
import path from 'node:path'
import type { DefaultsConfig, ServiceConfig } from './types.js'

/**
 * Load all service config JSON files from a directory.
 * Optionally filters to only the named services.
 */
export function loadServiceConfigs(
  servicesDir: string,
  filterServices?: string[],
): ServiceConfig[] {
  if (!fs.existsSync(servicesDir)) {
    throw new Error(`Services config directory not found: ${servicesDir}`)
  }

  const files = fs.readdirSync(servicesDir).filter((f) => f.endsWith('.json'))

  if (files.length === 0) {
    throw new Error(`No service config files found in: ${servicesDir}`)
  }

  const configs: ServiceConfig[] = []
  for (const file of files) {
    const filePath = path.join(servicesDir, file)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
    const config = validateServiceConfig(raw, file)
    configs.push(config)
  }

  // Filter by service names if specified (unless "all")
  if (filterServices && filterServices.length > 0 && !filterServices.includes('all')) {
    const filtered = configs.filter((c) => filterServices.includes(c.service))
    if (filtered.length === 0) {
      const available = configs.map((c) => c.service).join(', ')
      throw new Error(
        `No matching services found for: ${filterServices.join(', ')}. Available: ${available}`,
      )
    }
    return filtered
  }

  return configs
}

/** Load global defaults config from a JSON file */
export function loadDefaults(filePath: string): DefaultsConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Defaults config not found: ${filePath}`)
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
  return validateDefaults(raw)
}

/** Runtime validation for a service config object */
export function validateServiceConfig(raw: unknown, source = 'unknown'): ServiceConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`[${source}] Service config must be a JSON object`)
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj.service !== 'string' || obj.service.length === 0) {
    throw new Error(`[${source}] Missing or empty required field: "service"`)
  }

  if (!Array.isArray(obj.templates) || obj.templates.length === 0) {
    throw new Error(`[${source}] Missing or empty required field: "templates"`)
  }

  // Validate each template
  for (let i = 0; i < obj.templates.length; i++) {
    validateTemplate(obj.templates[i] as unknown, source, i)
  }

  // Validate generators if present
  if (obj.generators !== undefined) {
    validateGenerators(obj.generators, source, 'service')
  }

  // Validate spike if present
  if (obj.spike !== undefined) {
    validateSpike(obj.spike, source)
  }

  return raw as ServiceConfig
}

function validateTemplate(raw: unknown, source: string, index: number): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`[${source}] templates[${index}] must be an object`)
  }

  const t = raw as Record<string, unknown>

  if (typeof t.message !== 'string' || t.message.length === 0) {
    throw new Error(`[${source}] templates[${index}] missing required field: "message"`)
  }

  if (typeof t.level !== 'string' || t.level.length === 0) {
    throw new Error(`[${source}] templates[${index}] missing required field: "level"`)
  }

  if (t.weight !== undefined && (typeof t.weight !== 'number' || t.weight < 0)) {
    throw new Error(`[${source}] templates[${index}] "weight" must be a non-negative number`)
  }

  if (t.generators !== undefined) {
    validateGenerators(t.generators, source, `templates[${index}]`)
  }
}

function validateGenerators(raw: unknown, source: string, context: string): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`[${source}] ${context}.generators must be an object`)
  }

  const gens = raw as Record<string, unknown>
  for (const [name, config] of Object.entries(gens)) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error(`[${source}] ${context}.generators["${name}"] must be an object`)
    }

    const g = config as Record<string, unknown>
    if (typeof g.type !== 'string') {
      throw new Error(`[${source}] ${context}.generators["${name}"] missing "type" field`)
    }

    const validTypes = [
      'choice',
      'weighted_choice',
      'int',
      'float',
      'uuid',
      'ip',
      'email',
      'sequence',
      'timestamp',
    ]
    if (!validTypes.includes(g.type)) {
      throw new Error(
        `[${source}] ${context}.generators["${name}"] invalid type: "${g.type}". ` +
          `Valid: ${validTypes.join(', ')}`,
      )
    }
  }
}

function validateSpike(raw: unknown, source: string): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`[${source}] "spike" must be an object`)
  }

  const spike = raw as Record<string, unknown>

  if (spike.extra_templates !== undefined) {
    if (!Array.isArray(spike.extra_templates)) {
      throw new Error(`[${source}] spike.extra_templates must be an array`)
    }
    for (let i = 0; i < spike.extra_templates.length; i++) {
      validateTemplate(spike.extra_templates[i] as unknown, source, i)
    }
  }

  if (
    spike.error_weight_multiplier !== undefined &&
    (typeof spike.error_weight_multiplier !== 'number' || spike.error_weight_multiplier < 0)
  ) {
    throw new Error(`[${source}] spike.error_weight_multiplier must be a non-negative number`)
  }
}

function validateDefaults(raw: unknown): DefaultsConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Defaults config must be a JSON object')
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj.rate !== 'number' || obj.rate <= 0) {
    throw new Error('Defaults: "rate" must be a positive number')
  }

  if (typeof obj.buffer_size !== 'number' || obj.buffer_size <= 0) {
    throw new Error('Defaults: "buffer_size" must be a positive number')
  }

  if (typeof obj.flush_interval_ms !== 'number' || obj.flush_interval_ms <= 0) {
    throw new Error('Defaults: "flush_interval_ms" must be a positive number')
  }

  const validModes = ['steady', 'deploy-spike', 'error-storm', 'quiet', 'chaos']
  if (typeof obj.mode !== 'string' || !validModes.includes(obj.mode)) {
    throw new Error(`Defaults: "mode" must be one of: ${validModes.join(', ')}`)
  }

  if (typeof obj.mode_timings !== 'object' || obj.mode_timings === null) {
    throw new Error('Defaults: "mode_timings" must be an object')
  }

  const timings = obj.mode_timings as Record<string, unknown>
  const requiredTimings = [
    'spike_duration_seconds',
    'storm_duration_seconds',
    'quiet_duration_seconds',
    'chaos_steady_min_seconds',
    'chaos_steady_max_seconds',
  ]

  for (const field of requiredTimings) {
    if (typeof timings[field] !== 'number' || (timings[field] as number) <= 0) {
      throw new Error(`Defaults: mode_timings.${field} must be a positive number`)
    }
  }

  return raw as DefaultsConfig
}
