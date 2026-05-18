/**
 * Centralised tooltip strings. Import TOOLTIPS and reference by key so copy
 * changes happen in one place. Add new keys here before wiring them up in
 * components — never inline tooltip text in component files.
 */
export const TOOLTIPS = {
  // --- KPI Strip ---
  spikesActive:
    'Patterns with anomaly scores above the threshold. These are patterns experiencing unusual activity compared to their baseline.',
  newToday:
    'Distinct log patterns seen for the first time today. A sudden spike often means a new deployment introduced new message patterns.',
  unclustered:
    'Log lines that could not be matched to any known pattern. High values may indicate a new message format or unusual log structure. These events are not analysed for anomalies.',
  errorRate:
    'Percentage of ingested events classified as errors (ERROR / FATAL severity) in the current time window. Turns red above 5%.',
  totalTemplates:
    'Total distinct log patterns tracked by LogWeave. Each pattern represents a unique message structure with variable parts replaced by placeholders.',

  // --- Template table ---
  trendColumn:
    'Occurrence rate over the selected time window, oldest → newest. Amber = rising, green = falling, indigo = stable.',
  newBadge:
    'This log pattern was seen for the first time today. It did not appear in any earlier time window.',

  // --- Template detail panel ---
  anomalyScore:
    "How far this pattern's recent occurrence rate deviates from its rolling baseline. 0 = normal; >0.5 = elevated (amber); >1.0 = anomalous (red).",
  avgDuration:
    'Average duration of the operation that produced this log pattern, extracted from the duration field in the log payload. Only populated if your logs include a numeric duration value.',
  occurrenceHistory:
    'Occurrence counts per time bucket, oldest to newest, over the selected window. Each number is how many times this pattern matched in one interval. Use this to spot gradual growth or a sudden burst.',
  templatePlaceholder:
    'Dynamic value that changes between log lines. LogWeave replaces variable parts (IPs, IDs, timestamps) with placeholders so similar messages group into one pattern.',

  // --- Compression funnel ---
  compressionRatio:
    'Total log events ÷ unique patterns. A ratio of 500:1 means 500 raw lines were reduced to 1 stored pattern. Higher is better.',
  unclusteredFunnel:
    'Events that could not be matched to any known pattern and are not analysed for anomalies. If this is persistently high, your log format may need adjustment.',

  // --- Changes panel ---
  spikeEvent:
    "This pattern's occurrence count is significantly higher than its recent rolling average. The multiplier shows how many times above baseline it is.",
  newEvent:
    'This log pattern appeared for the first time in the current time window. A high count on a brand-new pattern warrants investigation.',
  resolvedEvent:
    'This pattern previously had an anomalous spike. Its occurrence count has returned to within the normal baseline range.',

  // --- Volume chart ---
  compareToggle:
    'Overlays the equivalent previous time window in dashed lines so you can compare current volume against the prior period.',
} as const
