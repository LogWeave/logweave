import crypto from 'node:crypto'
import type { GeneratorConfig } from './types.js'

const EMAIL_NAMES = ['alice', 'bob', 'charlie', 'diana', 'eve', 'frank', 'grace', 'heidi']
const EMAIL_DOMAINS = ['example.com', 'test.org', 'demo.io', 'logweave.dev']

/** Built-in generators available without explicit config */
const BUILTIN_GENERATORS: Record<string, GeneratorConfig> = {
  uuid: { type: 'uuid' },
  ip: { type: 'ip' },
  email: { type: 'email' },
  timestamp: { type: 'timestamp' },
}

/** Generate a single value from a GeneratorConfig */
function generateValue(config: GeneratorConfig, sequenceState: Map<string, number>): unknown {
  switch (config.type) {
    case 'choice': {
      const idx = Math.floor(Math.random() * config.values.length)
      return config.values[idx]
    }

    case 'weighted_choice': {
      const totalWeight = config.values.reduce((sum, entry) => sum + entry.weight, 0)
      let roll = Math.random() * totalWeight
      for (const entry of config.values) {
        roll -= entry.weight
        if (roll <= 0) return entry.value
      }
      // Fallback to last entry (floating point edge case)
      return config.values.at(-1)?.value
    }

    case 'int': {
      return Math.floor(Math.random() * (config.max - config.min + 1)) + config.min
    }

    case 'float': {
      const decimals = config.decimals ?? 2
      const raw = Math.random() * (config.max - config.min) + config.min
      return Number.parseFloat(raw.toFixed(decimals))
    }

    case 'uuid': {
      return crypto.randomUUID()
    }

    case 'ip': {
      // Generate random private IPs (10.x.x.x or 192.168.x.x)
      if (Math.random() < 0.5) {
        const a = Math.floor(Math.random() * 256)
        const b = Math.floor(Math.random() * 256)
        const c = Math.floor(Math.random() * 256)
        return `10.${a}.${b}.${c}`
      }
      const b = Math.floor(Math.random() * 256)
      const c = Math.floor(Math.random() * 256)
      return `192.168.${b}.${c}`
    }

    case 'email': {
      const name = EMAIL_NAMES[Math.floor(Math.random() * EMAIL_NAMES.length)]
      const domain = EMAIL_DOMAINS[Math.floor(Math.random() * EMAIL_DOMAINS.length)]
      return `${name}@${domain}`
    }

    case 'sequence': {
      const key = `seq:${config.prefix}`
      const current = sequenceState.get(key) ?? config.start ?? 1
      sequenceState.set(key, current + 1)
      return `${config.prefix}${current}`
    }

    case 'timestamp': {
      return new Date().toISOString()
    }
  }
}

/**
 * Registry of value generators. Supports service-level defaults
 * and template-level overrides via child().
 */
export class GeneratorRegistry {
  private readonly configs: Record<string, GeneratorConfig>
  private readonly sequenceState: Map<string, number>

  constructor(
    serviceGenerators: Record<string, GeneratorConfig> = {},
    sequenceState?: Map<string, number>,
  ) {
    this.configs = { ...BUILTIN_GENERATORS, ...serviceGenerators }
    this.sequenceState = sequenceState ?? new Map()
  }

  /**
   * Create a child registry with template-level overrides.
   * Shares sequence state with the parent.
   */
  child(overrides: Record<string, GeneratorConfig>): GeneratorRegistry {
    const merged = { ...this.configs, ...overrides }
    return new GeneratorRegistry(merged, this.sequenceState)
  }

  /** Resolve a generator by name and return a generated value */
  resolve(name: string): unknown {
    const config = this.configs[name]
    if (!config) {
      throw new Error(`Unknown generator: "${name}"`)
    }
    return generateValue(config, this.sequenceState)
  }

  /** Check whether a generator name is registered */
  has(name: string): boolean {
    return name in this.configs
  }
}

/**
 * If value is a { "$gen": "name" } object, resolve it via the registry.
 * Otherwise return the value as-is.
 */
export function resolveFieldValue(value: unknown, registry: GeneratorRegistry): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '$gen' in value &&
    typeof (value as Record<string, unknown>).$gen === 'string'
  ) {
    return registry.resolve((value as Record<string, unknown>).$gen as string)
  }
  return value
}
