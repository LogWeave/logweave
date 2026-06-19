import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LogWeaveClient } from '../client.js'
import { type ApiResponse, READ_ONLY, toolHandler, WRITE_OP } from '../shared/handler.js'

async function listRules(client: LogWeaveClient): Promise<string> {
  const res = (await client.get('/rules')) as ApiResponse
  const rules = (res.data as Array<Record<string, unknown>>) ?? []

  if (rules.length === 0) {
    return 'No alert rules configured.'
  }

  let text = `## Alert Rules (${rules.length})\n\n`
  for (const r of rules) {
    const status = r.enabled ? 'enabled' : 'disabled'
    const type = r.ruleType === 'threshold' ? 'threshold' : 'template_watch'
    text += `### ${r.name} [${status}]\n`
    text += `- Type: ${type}\n`
    text += `- Rule ID: ${r.ruleId}\n`

    const config = r.config as Record<string, unknown>
    if (r.ruleType === 'threshold') {
      text += `- Condition: ${config.service} ${config.metric} ${config.operator} ${config.value} (${config.windowMinutes}min window)\n`
    } else {
      text += `- Template: ${config.templateText} [id: ${config.templateId}]\n`
    }

    const channels = (r.channels as string[]) ?? []
    if (channels.length > 0) {
      text += `- Channels: ${channels.length} webhook(s)\n`
    } else {
      text += `- Channels: tenant default\n`
    }
    text += '\n'
  }

  return text
}

async function createRule(
  client: LogWeaveClient,
  args: {
    name: string
    rule_type: 'threshold' | 'template_watch'
    metric?: string
    service?: string
    operator?: string
    value?: number
    window_minutes?: number
    template_id?: string
    template_text?: string
    channels?: string[]
  },
): Promise<string> {
  if (args.rule_type === 'template_watch') {
    if (!args.template_id)
      return 'Error: template_id is required for template_watch rules. Get the ID from error_patterns or search_templates.'
    if (!args.template_text)
      return 'Error: template_text is required for template_watch rules. Copy it from the pattern listing in error_patterns or search_templates.'

    const body = {
      name: args.name,
      ruleType: 'template_watch',
      config: {
        templateId: args.template_id,
        templateText: args.template_text,
      },
      channels: args.channels ?? [],
    }
    const res = (await client.post('/rules', body)) as ApiResponse
    const rule = res.data as Record<string, unknown>

    let text = `## Rule Created\n\n`
    text += `- Name: ${rule.name}\n`
    text += `- Rule ID: ${rule.ruleId}\n`
    text += `- Type: template_watch\n`
    text += `- Pattern: ${args.template_text ?? args.template_id}\n`
    text += `- Enabled: ${rule.enabled}\n`
    const channels = (rule.channels as string[]) ?? []
    text += `- Channels: ${channels.length > 0 ? `${channels.length} webhook(s)` : 'tenant default'}\n`
    return text
  }

  // threshold rule
  if (!args.metric) return 'Error: metric is required for threshold rules.'
  if (!args.service) return 'Error: service is required for threshold rules.'
  if (!args.operator) return 'Error: operator is required for threshold rules.'
  if (args.value === undefined) return 'Error: value is required for threshold rules.'
  if (!args.window_minutes) return 'Error: window_minutes is required for threshold rules.'

  const body = {
    name: args.name,
    ruleType: 'threshold',
    config: {
      metric: args.metric,
      service: args.service,
      operator: args.operator,
      value: args.value,
      windowMinutes: args.window_minutes,
    },
    channels: args.channels ?? [],
  }

  const res = (await client.post('/rules', body)) as ApiResponse
  const rule = res.data as Record<string, unknown>

  let text = `## Rule Created\n\n`
  text += `- Name: ${rule.name}\n`
  text += `- Rule ID: ${rule.ruleId}\n`
  text += `- Type: threshold\n`
  text += `- Condition: ${args.service} ${args.metric} ${args.operator} ${args.value} (${args.window_minutes}min window)\n`
  text += `- Enabled: ${rule.enabled}\n`

  const channels = (rule.channels as string[]) ?? []
  text += `- Channels: ${channels.length > 0 ? `${channels.length} webhook(s)` : 'tenant default'}\n`

  return text
}

async function listAlerts(
  client: LogWeaveClient,
  args: { hours?: number; rule_id?: string; service?: string; limit?: number },
): Promise<string> {
  const res = (await client.get('/alerts', {
    hours: args.hours,
    ruleId: args.rule_id,
    service: args.service,
    limit: args.limit,
  })) as ApiResponse

  const alerts = (res.data as Array<Record<string, unknown>>) ?? []
  const hours = (res.meta.hours as number) ?? args.hours ?? 24

  if (alerts.length === 0) {
    return `No alerts fired in the last ${hours} hours.`
  }

  let text = `## Alert History (${alerts.length} alerts, last ${hours}h)\n\n`
  for (const a of alerts) {
    const ts = (a.firedAt as string).slice(0, 19).replace('T', ' ')
    const details = (a.details as Record<string, unknown>) ?? {}
    const service = (details.service as string) ?? 'unknown'

    text += `### ${a.ruleName} — ${ts}\n`
    text += `- Type: ${a.ruleType}\n`
    text += `- Service: ${service}\n`

    if (a.ruleType === 'threshold' || a.ruleType === 'threshold_breach') {
      text += `- Value: ${a.metricValue} (threshold: ${a.thresholdValue})\n`
      if (details.metric)
        text += `- Metric: ${details.metric} ${details.operator} ${a.thresholdValue} (${details.windowMinutes}min)\n`
    } else {
      text += `- Anomaly score: ${a.metricValue}\n`
    }

    const channels = (a.channelsNotified as string[]) ?? []
    if (channels.length > 0) {
      text += `- Notified: ${channels.length} channel(s)\n`
    }
    text += '\n'
  }

  return text
}

export function registerRules(server: McpServer, client: LogWeaveClient): void {
  server.registerTool(
    'list_rules',
    {
      title: 'List Alert Rules',
      description:
        'Show all alert rules for this tenant with their configs, status, and channel assignments. ' +
        'Use this to see what alerting is configured before creating new rules.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    toolHandler(() => listRules(client)),
  )

  server.registerTool(
    'create_rule',
    {
      title: 'Create Alert Rule',
      description:
        'Create an alert rule. Two types: ' +
        '(1) threshold — alert when a service metric exceeds a value (e.g. "alert if payments has >10 errors in 5 minutes"). ' +
        '(2) template_watch — alert whenever a specific log pattern appears (use after finding a pattern with error_patterns or search_templates). ' +
        'Use list_rules to verify creation.',
      inputSchema: {
        name: z.string().describe('Human-readable rule name'),
        rule_type: z
          .enum(['threshold', 'template_watch'])
          .describe(
            'Rule type: "threshold" for metric-based alerts, "template_watch" to alert on a specific log pattern',
          ),
        // threshold fields
        metric: z
          .enum(['error_count', 'warn_count', 'log_count'])
          .optional()
          .describe('(threshold only) Metric to monitor'),
        service: z.string().optional().describe('(threshold only) Service name to monitor'),
        operator: z
          .enum(['>', '>=', '<', '<='])
          .optional()
          .describe('(threshold only) Comparison operator'),
        value: z.number().optional().describe('(threshold only) Threshold value'),
        window_minutes: z
          .number()
          .optional()
          .describe('(threshold only) Evaluation window in minutes (1-60)'),
        // template_watch fields
        template_id: z
          .string()
          .optional()
          .describe(
            '(template_watch only) Template ID to watch — get this from error_patterns or search_templates',
          ),
        template_text: z
          .string()
          .optional()
          .describe(
            '(template_watch only, required) Template text for display — copy from the pattern listing. The API rejects template_watch rules without it.',
          ),
        // shared
        channels: z
          .array(z.string())
          .optional()
          .describe(
            'Webhook URLs or PagerDuty routing keys for notifications (empty = tenant default)',
          ),
      },
      annotations: WRITE_OP,
    },
    toolHandler((args) =>
      createRule(
        client,
        args as {
          name: string
          rule_type: 'threshold' | 'template_watch'
          metric?: string
          service?: string
          operator?: string
          value?: number
          window_minutes?: number
          template_id?: string
          template_text?: string
          channels?: string[]
        },
      ),
    ),
  )

  server.registerTool(
    'list_alerts',
    {
      title: 'Alert History',
      description:
        'Query recent alert history — what rules fired, when, and what triggered them. ' +
        'Filter by service or rule_id. Use this to investigate alert activity.',
      inputSchema: {
        hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)'),
        rule_id: z.string().optional().describe('Filter to a specific rule ID'),
        service: z.string().optional().describe('Filter to alerts from a specific service'),
        limit: z.number().optional().describe('Max results (default: 100, max: 500)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) =>
      listAlerts(
        client,
        args as { hours?: number; rule_id?: string; service?: string; limit?: number },
      ),
    ),
  )
}
