import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import type { AlertEvent, TemplateAlertEvent, ThresholdAlertEvent } from '../../src/watches/alert-observer.js'
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
    assert.equal(row.channels_notified, '["https://hooks.slack.com/abc"]')

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
