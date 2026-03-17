import { GeneratorRegistry, resolveFieldValue } from './generator.js'
import type { ServiceConfig, TemplateConfig } from './types.js'

/** Regex for {{placeholder}} patterns in message templates */
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

interface WeightedTemplate {
  template: TemplateConfig
  registry: GeneratorRegistry
}

/**
 * Engine for weighted template selection and placeholder resolution.
 * Supports mode transitions: spike activation, error storm, and deactivation.
 */
export class TemplateEngine {
  /** Service name for this engine, exposed for logging/display */
  readonly serviceName: string

  private readonly serviceConfig: ServiceConfig
  private readonly baseRegistry: GeneratorRegistry

  /** Normal-mode templates (no spike) */
  private readonly baseTemplates: TemplateConfig[]

  /** Currently active weighted template set */
  private activeEntries: WeightedTemplate[]
  private cumulativeWeights: number[] = []
  private totalWeight = 0

  /** Track current mode for deactivation */
  private spikeActive = false
  private stormActive = false

  constructor(serviceConfig: ServiceConfig) {
    this.serviceConfig = serviceConfig
    this.serviceName = serviceConfig.service
    this.baseRegistry = new GeneratorRegistry(serviceConfig.generators ?? {})
    this.baseTemplates = [...serviceConfig.templates]
    this.activeEntries = this.buildEntries(this.baseTemplates)
    this.rebuildWeights()
  }

  /** Generate a complete log event from a weighted-random template */
  generate(): Record<string, unknown> {
    const entry = this.pickTemplate()
    const message = this.resolvePlaceholders(entry.template.message, entry.registry)

    const event: Record<string, unknown> = {
      level: entry.template.level,
      message,
      timestamp: new Date().toISOString(),
      service: this.serviceConfig.service,
    }

    // Add environment if configured
    if (this.serviceConfig.environment) {
      event.environment = this.serviceConfig.environment
    }

    // Merge service-level metadata
    if (this.serviceConfig.metadata) {
      for (const [key, val] of Object.entries(this.serviceConfig.metadata)) {
        event[key] = resolveFieldValue(val, entry.registry)
      }
    }

    // Resolve template fields
    if (entry.template.fields) {
      for (const [key, val] of Object.entries(entry.template.fields)) {
        event[key] = resolveFieldValue(val, entry.registry)
      }
    }

    return event
  }

  /** Activate deploy-spike mode: merge spike templates, boost error weights */
  activateSpike(): void {
    if (this.spikeActive) return

    const spike = this.serviceConfig.spike
    const templates = [...this.baseTemplates]

    // Add extra spike templates
    if (spike?.extra_templates) {
      templates.push(...spike.extra_templates)
    }

    // Apply error weight multiplier
    const multiplier = spike?.error_weight_multiplier ?? 3
    const boosted = templates.map((t) => {
      if (t.level === 'error' || t.level === 'fatal') {
        return { ...t, weight: (t.weight ?? 1) * multiplier }
      }
      return t
    })

    this.activeEntries = this.buildEntries(boosted)
    this.rebuildWeights()
    this.spikeActive = true
  }

  /** Deactivate deploy-spike mode: revert to base templates */
  deactivateSpike(): void {
    if (!this.spikeActive) return
    this.activeEntries = this.buildEntries(this.baseTemplates)
    this.rebuildWeights()
    this.spikeActive = false
  }

  /** Activate error-storm mode: error/fatal templates get 50% of total weight */
  activateErrorStorm(): void {
    if (this.stormActive) return

    const templates = this.spikeActive
      ? this.activeEntries.map((e) => e.template)
      : [...this.baseTemplates]

    const errorTemplates = templates.filter((t) => t.level === 'error' || t.level === 'fatal')
    const normalTemplates = templates.filter((t) => t.level !== 'error' && t.level !== 'fatal')

    if (errorTemplates.length === 0 || normalTemplates.length === 0) {
      // Nothing to adjust, keep current
      this.stormActive = true
      return
    }

    // Calculate current total weights
    const normalTotal = normalTemplates.reduce((sum, t) => sum + (t.weight ?? 1), 0)
    const errorTotal = errorTemplates.reduce((sum, t) => sum + (t.weight ?? 1), 0)

    // We want error templates to be 50% of total weight.
    // So errorTotal * multiplier = normalTotal (making them equal = 50/50)
    const multiplier = normalTotal / errorTotal

    const adjusted = [
      ...normalTemplates,
      ...errorTemplates.map((t) => ({
        ...t,
        weight: (t.weight ?? 1) * multiplier,
      })),
    ]

    this.activeEntries = this.buildEntries(adjusted)
    this.rebuildWeights()
    this.stormActive = true
  }

  /** Deactivate error-storm mode */
  deactivateErrorStorm(): void {
    if (!this.stormActive) return

    // Revert to base (or spike if spike is active)
    if (this.spikeActive) {
      // Re-apply spike without storm
      this.stormActive = false
      this.spikeActive = false
      this.activateSpike()
    } else {
      this.activeEntries = this.buildEntries(this.baseTemplates)
      this.rebuildWeights()
    }
    this.stormActive = false
  }

  /** Build WeightedTemplate entries with per-template registries */
  private buildEntries(templates: TemplateConfig[]): WeightedTemplate[] {
    return templates.map((template) => {
      const registry = template.generators
        ? this.baseRegistry.child(template.generators)
        : this.baseRegistry
      return { template, registry }
    })
  }

  /** Rebuild cumulative weight array for binary search selection */
  private rebuildWeights(): void {
    this.cumulativeWeights = []
    let cumulative = 0
    for (const entry of this.activeEntries) {
      cumulative += entry.template.weight ?? 1
      this.cumulativeWeights.push(cumulative)
    }
    this.totalWeight = cumulative
  }

  /** Pick a template using weighted random selection with binary search */
  private pickTemplate(): WeightedTemplate {
    const roll = Math.random() * this.totalWeight

    // Binary search for the first cumulative weight > roll
    let lo = 0
    let hi = this.cumulativeWeights.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((this.cumulativeWeights[mid] ?? 0) <= roll) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return this.activeEntries[lo] as WeightedTemplate
  }

  /** Replace {{placeholder}} tokens in a message template */
  private resolvePlaceholders(message: string, registry: GeneratorRegistry): string {
    return message.replace(PLACEHOLDER_RE, (_match, name: string) => {
      return String(registry.resolve(name))
    })
  }
}
