import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GenericLogParser } from '../../src/pipeline/parse-generic.js'

const parser = new GenericLogParser()
const noExtract = new Set<string>()

describe('GenericLogParser', () => {
  describe('extractMessage', () => {
    it('extracts from "message" field', () => {
      assert.equal(parser.extractMessage({ message: 'hello' }), 'hello')
    })

    it('extracts from "msg" field', () => {
      assert.equal(parser.extractMessage({ msg: 'hello' }), 'hello')
    })

    it('extracts from "log" field (Docker/FluentBit)', () => {
      assert.equal(parser.extractMessage({ log: 'container output line' }), 'container output line')
    })

    it('extracts from "body" field (OTel flat JSON)', () => {
      assert.equal(parser.extractMessage({ body: 'log body text' }), 'log body text')
    })

    it('prefers message over msg over log over body', () => {
      assert.equal(parser.extractMessage({ message: 'a', msg: 'b', log: 'c', body: 'd' }), 'a')
      assert.equal(parser.extractMessage({ msg: 'b', log: 'c' }), 'b')
      assert.equal(parser.extractMessage({ log: 'c', body: 'd' }), 'c')
    })

    it('returns undefined for no message field', () => {
      assert.equal(parser.extractMessage({ level: 'INFO' }), undefined)
    })

    it('returns undefined for non-string message', () => {
      assert.equal(parser.extractMessage({ message: 123 }), undefined)
    })
  })

  describe('extractFields', () => {
    it('extracts standard fields', () => {
      const fields = parser.extractFields(
        { service: 'api', level: 'ERROR', environment: 'prod' },
        noExtract,
      )
      assert.equal(fields.service, 'api')
      assert.equal(fields.level, 'ERROR')
      assert.equal(fields.environment, 'prod')
    })

    it('extracts trace_id and traceId', () => {
      assert.equal(parser.extractFields({ trace_id: 'abc123' }, noExtract).traceId, 'abc123')
      assert.equal(parser.extractFields({ traceId: 'def456' }, noExtract).traceId, 'def456')
    })

    it('respects neverExtract', () => {
      const fields = parser.extractFields({ service: 'api', level: 'ERROR' }, new Set(['service']))
      assert.equal(fields.service, undefined)
      assert.equal(fields.level, 'ERROR')
    })
  })
})
