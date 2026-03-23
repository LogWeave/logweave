import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { otlpToEvents } from '../../src/pipeline/parse-otlp.js'

describe('otlpToEvents', () => {
  it('flattens a basic OTLP ExportLogsServiceRequest', () => {
    const body = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'payment-api' } },
              { key: 'deployment.environment', value: { stringValue: 'prod' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1679000000000000000',
                  severityText: 'ERROR',
                  body: { stringValue: 'Connection refused to database' },
                  traceId: 'abcdef1234567890abcdef1234567890',
                  attributes: [
                    { key: 'http.status_code', value: { intValue: '500' } },
                    { key: 'http.route', value: { stringValue: '/api/payments' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const events = otlpToEvents(body)

    assert.equal(events.length, 1)
    assert.equal(events[0].message, 'Connection refused to database')
    assert.equal(events[0].service, 'payment-api')
    assert.equal(events[0].level, 'ERROR')
    assert.equal(events[0].environment, 'prod')
    assert.equal(events[0].statusCode, 500)
    assert.equal(events[0].route, '/api/payments')
    assert.equal(events[0].traceId, 'abcdef1234567890abcdef1234567890')
    assert.ok(events[0].timestamp)
  })

  it('handles multiple log records across scopes and resources', () => {
    const body = {
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'svc-a' } }],
          },
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: 'msg 1' }, severityText: 'INFO' },
                { body: { stringValue: 'msg 2' }, severityText: 'WARN' },
              ],
            },
          ],
        },
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'svc-b' } }],
          },
          scopeLogs: [
            {
              logRecords: [{ body: { stringValue: 'msg 3' }, severityText: 'ERROR' }],
            },
          ],
        },
      ],
    }

    const events = otlpToEvents(body)

    assert.equal(events.length, 3)
    assert.equal(events[0].service, 'svc-a')
    assert.equal(events[1].service, 'svc-a')
    assert.equal(events[2].service, 'svc-b')
  })

  it('skips log records with empty body', () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: '' }, severityText: 'INFO' },
                { body: { stringValue: 'real message' }, severityText: 'WARN' },
              ],
            },
          ],
        },
      ],
    }

    const events = otlpToEvents(body)

    assert.equal(events.length, 1)
    assert.equal(events[0].message, 'real message')
  })

  it('maps severityNumber to level when severityText missing', () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: 'msg' }, severityNumber: 17 },
              ],
            },
          ],
        },
      ],
    }

    const events = otlpToEvents(body)
    assert.equal(events[0].level, 'ERROR')
  })

  it('converts timeUnixNano to ISO timestamp', () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'msg' },
                  timeUnixNano: '1679000000123456789',
                  severityText: 'INFO',
                },
              ],
            },
          ],
        },
      ],
    }

    const events = otlpToEvents(body)
    assert.ok(events[0].timestamp.startsWith('2023-03-1'))
  })

  it('normalizes traceId — lowercases and strips 0x prefix', () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'msg' },
                  traceId: '0xABCDEF1234567890ABCDEF1234567890',
                  severityText: 'INFO',
                },
              ],
            },
          ],
        },
      ],
    }

    const events = otlpToEvents(body)
    assert.equal(events[0].traceId, 'abcdef1234567890abcdef1234567890')
  })

  it('returns empty array for empty resourceLogs', () => {
    assert.deepEqual(otlpToEvents({ resourceLogs: [] }), [])
  })

  it('returns empty array for missing resourceLogs', () => {
    assert.deepEqual(otlpToEvents({}), [])
  })
})
