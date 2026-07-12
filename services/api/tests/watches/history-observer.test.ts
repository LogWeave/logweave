import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import type {
  ServiceSilenceResolvedEvent,
  ServiceSilentEvent,
  TemplateAlertEvent,
  ThresholdAlertEvent,
} from '../../src/watches/alert-observer.js'
import { HistoryObserver } from '../../src/watches/history-observer.js'

const silentLogger = pino({ level: 'silent' })

function makeTemplateAlert(): TemplateAlertEvent {
  return {
    type: 'spike',
    tenantId: 't1',
    service: 'api',
    templateId: 'tmpl-123',
    templateText: 'Error in <*>',
    currentCount: 50,
    baselineCount: 10,
    score: 5.0,
    triggeredAt: '2026-03-22T10:00:00.000Z',
  }
}

function makeThresholdAlert(): ThresholdAlertEvent {
  return {
    type: 'threshold_breach',
    tenantId: 't1',
    service: 'payments',
    ruleId: 'rule-456',
    ruleName: 'High error rate',
    metric: 'error_count',
    metricValue: 25,
    thresholdValue: 10,
    operator: '>',
    windowMinutes: 5,
    triggeredAt: '2026-03-22T10:00:00.000Z',
    channels: ['https://hooks.slack.com/abc'],
  }
}

function makeServiceSilentAlert(): ServiceSilentEvent {
  return {
    type: 'service_silent',
    tenantId: 't1',
    service: 'checkout',
    expectedCount: 20,
    actualCount: 0,
    triggeredAt: '2026-03-22T10:00:00.000Z',
  }
}

function makeServiceSilenceResolvedAlert(): ServiceSilenceResolvedEvent {
  return {
    type: 'service_silence_resolved',
    tenantId: 't1',
    service: 'checkout',
    resolvedAt: '2026-03-22T10:05:00.000Z',
  }
}

describe('HistoryObserver', () => {
  it('inserts template alert into alert_history', async () => {
    const insertedRows: unknown[] = []
    const db = {
      insert: async (params: { table: string; values: unknown[] }) => {
        insertedRows.push(...params.values)
      },
    } as unknown as DbClient

    const observer = new HistoryObserver({ db, logger: silentLogger })
    await observer.notify(makeTemplateAlert())

    assert.equal(insertedRows.length, 1)
    const row = insertedRows[0] as Record<string, unknown>
    assert.equal(row.tenant_id, 't1')
    assert.equal(row.rule_id, 'tmpl-123')
    assert.equal(row.rule_type, 'spike')
    assert.equal(row.rule_name, 'Error in <*>')
    assert.equal(row.metric_value, 5.0)
    assert.equal(row.threshold_value, 1.0)
    assert.equal(row.channels_notified, '[]')

    // alert_id should be a UUIDv7
    assert.match(row.alert_id as string, /^[0-9a-f-]{36}$/)

    // details should be valid JSON with expected fields
    const details = JSON.parse(row.details as string)
    assert.equal(details.service, 'api')
    assert.equal(details.currentCount, 50)
    assert.equal(details.baselineCount, 10)
  })

  it('inserts threshold alert into alert_history', async () => {
    const insertedRows: unknown[] = []
    const db = {
      insert: async (params: { table: string; values: unknown[] }) => {
        insertedRows.push(...params.values)
      },
    } as unknown as DbClient

    const observer = new HistoryObserver({ db, logger: silentLogger })
    await observer.notify(makeThresholdAlert())

    assert.equal(insertedRows.length, 1)
    const row = insertedRows[0] as Record<string, unknown>
    assert.equal(row.tenant_id, 't1')
    assert.equal(row.rule_id, 'rule-456')
    assert.equal(row.rule_type, 'threshold')
    assert.equal(row.rule_name, 'High error rate')
    assert.equal(row.metric_value, 25)
    assert.equal(row.threshold_value, 10)
    // channels_notified records channels confirmed *delivered*, not merely
    // configured. The HistoryObserver can't observe the async delivery
    // observers' outcomes, so it records none rather than over-claiming that
    // the rule's configured channels were notified.
    assert.equal(row.channels_notified, '[]')

    const details = JSON.parse(row.details as string)
    assert.equal(details.service, 'payments')
    assert.equal(details.metric, 'error_count')
    assert.equal(details.operator, '>')
    assert.equal(details.windowMinutes, 5)
  })

  it('includes environment in threshold alert details when set', async () => {
    const insertedRows: unknown[] = []
    const db = {
      insert: async (params: { table: string; values: unknown[] }) => {
        insertedRows.push(...params.values)
      },
    } as unknown as DbClient

    const observer = new HistoryObserver({ db, logger: silentLogger })
    await observer.notify({ ...makeThresholdAlert(), environment: 'production' })

    assert.equal(insertedRows.length, 1)
    const row = insertedRows[0] as Record<string, unknown>
    const details = JSON.parse(row.details as string)
    assert.equal(details.environment, 'production')
  })

  it('omits environment from threshold alert details when not set', async () => {
    const insertedRows: unknown[] = []
    const db = {
      insert: async (params: { table: string; values: unknown[] }) => {
        insertedRows.push(...params.values)
      },
    } as unknown as DbClient

    const observer = new HistoryObserver({ db, logger: silentLogger })
    await observer.notify(makeThresholdAlert())

    assert.equal(insertedRows.length, 1)
    const row = insertedRows[0] as Record<string, unknown>
    const details = JSON.parse(row.details as string)
    assert.equal(details.environment, undefined)
  })

  it('does not throw on DB insert failure', async () => {
    const db = {
      insert: async () => {
        throw new Error('DB insert failed')
      },
    } as unknown as DbClient

    const observer = new HistoryObserver({ db, logger: silentLogger })
    // Should resolve without throwing
    await observer.notify(makeTemplateAlert())
  })

  it('inserts service_silent alert into alert_history', async () => {
    const insertedRows: unknown[] = []
    const db = {
      insert: async (params: { table: string; values: unknown[] }) => {
        insertedRows.push(...params.values)
      },
    } as unknown as DbClient

    const observer = new HistoryObserver({ db, logger: silentLogger })
    await observer.notify(makeServiceSilentAlert())

    assert.equal(insertedRows.length, 1)
    const row = insertedRows[0] as Record<string, unknown>
    assert.equal(row.tenant_id, 't1')
    assert.equal(row.rule_id, 'checkout')
    assert.equal(row.rule_type, 'service_silent')
    assert.equal(row.metric_value, 0)
    assert.equal(row.threshold_value, 20)
    assert.equal(row.channels_notified, '[]')

    const details = JSON.parse(row.details as string)
    assert.equal(details.service, 'checkout')
    assert.equal(details.expectedCount, 20)
    assert.equal(details.actualCount, 0)
  })

  it('does not insert service_silence_resolved into alert_history', async () => {
    const insertedRows: unknown[] = []
    const db = {
      insert: async (params: { table: string; values: unknown[] }) => {
        insertedRows.push(...params.values)
      },
    } as unknown as DbClient

    const observer = new HistoryObserver({ db, logger: silentLogger })
    await observer.notify(makeServiceSilenceResolvedAlert())

    assert.equal(insertedRows.length, 0)
  })

  it('inserts to logweave.alert_history table', async () => {
    let insertedTable = ''
    const db = {
      insert: async (params: { table: string; values: unknown[] }) => {
        insertedTable = params.table
      },
    } as unknown as DbClient

    const observer = new HistoryObserver({ db, logger: silentLogger })
    await observer.notify(makeTemplateAlert())
    assert.equal(insertedTable, 'logweave.alert_history')
  })
})
