/**
 * Centralised tooltip strings. Import TOOLTIPS and reference by key so copy
 * changes happen in one place. Add new keys here before wiring them up in
 * components — never inline tooltip text in component files.
 */
export const TOOLTIPS = {
  // --- KPI Strip ---
  newToday:
    'Distinct log templates seen for the first time today. A sudden spike often means a new deployment introduced new message patterns.',
  unclustered:
    'Log lines the clusterer could not match to any known template. High values may indicate a new message format or a clusterer configuration issue. These events are not analysed for anomalies.',
  errorRate:
    'Percentage of ingested events classified as errors (ERROR / FATAL severity) in the current time window. Turns red above 5%.',
  totalTemplates:
    'Total distinct log patterns tracked by LogWeave. Each pattern represents a unique message structure with variable parts replaced by placeholders.',

  // --- Template table ---
  trendColumn:
    'Occurrence rate over the selected time window, oldest → newest. Amber = rising, green = falling, indigo = stable.',
  newBadge:
    'This log template was seen for the first time today. It did not appear in any earlier time window.',

  // --- Template detail panel ---
  anomalyScore:
    'How far this pattern\'s recent occurrence rate deviates from its rolling baseline. 0 = normal; >0.5 = elevated (amber); >1.0 = anomalous (red).',
  avgDuration:
    'Average duration of the operation that produced this log pattern, extracted from the duration field in the log payload. Only populated if your logs include a numeric duration value.',
  occurrenceHistory:
    'Occurrence counts per time bucket, oldest to newest, over the selected window. Each number is how many times this pattern matched in one interval. Use this to spot gradual growth or a sudden burst.',
  templatePlaceholder:
    'Variable extracted by the Drain3 clustering algorithm. This token matches any value in that position across different log lines.',

  // --- Compression funnel ---
  compressionRatio:
    'Total log events ÷ unique templates. A ratio of 500:1 means 500 raw lines were reduced to 1 stored pattern. Higher is better.',
  unclusteredFunnel:
    'Events that fell back to template_id=0 and are not analysed for anomalies. If this is persistently high, check the clusterer service logs.',

  // --- Changes panel ---
  spikeEvent:
    'This template\'s occurrence count is significantly higher than its recent rolling average. The multiplier shows how many times above baseline it is.',
  newEvent:
    'This log template appeared for the first time in the current time window. A high count on a brand-new template warrants investigation.',
  resolvedEvent:
    'This template previously had an anomalous spike. Its occurrence count has returned to within the normal baseline range.',

  // --- Volume chart ---
  compareToggle:
    'Overlays the equivalent previous time window in dashed lines so you can compare current volume against the prior period.',
} as const

export type TooltipKey = keyof typeof TOOLTIPS
