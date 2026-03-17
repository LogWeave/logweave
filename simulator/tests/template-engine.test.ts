import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TemplateEngine } from '../src/template-engine.js'
import type { ServiceConfig } from '../src/types.js'

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    service: 'test-service',
    templates: [
      { message: 'Hello world', level: 'info' },
      { message: 'Something failed', level: 'error' },
    ],
    ...overrides,
  }
}

describe('TemplateEngine', () => {
  describe('generate()', () => {
    it('produces events with required fields', () => {
      const engine = new TemplateEngine(makeConfig())
      const event = engine.generate()

      assert.ok(typeof event.level === 'string', 'event.level should be a string')
      assert.ok(typeof event.message === 'string', 'event.message should be a string')
      assert.ok(typeof event.timestamp === 'string', 'event.timestamp should be a string')
      assert.equal(event.service, 'test-service')
    })

    it('includes environment when configured', () => {
      const engine = new TemplateEngine(makeConfig({ environment: 'production' }))
      const event = engine.generate()
      assert.equal(event.environment, 'production')
    })

    it('includes service metadata', () => {
      const engine = new TemplateEngine(
        makeConfig({
          metadata: { region: 'us-east-1', version: '2.1.0' },
        }),
      )
      const event = engine.generate()
      assert.equal(event.region, 'us-east-1')
      assert.equal(event.version, '2.1.0')
    })
  })

  describe('weighted selection', () => {
    it('selects only the heavily weighted template', () => {
      const engine = new TemplateEngine(
        makeConfig({
          templates: [
            { message: 'always', level: 'info', weight: 100 },
            { message: 'never', level: 'error', weight: 0 },
          ],
        }),
      )

      // With weight 100 vs 0, we should always get "always"
      for (let i = 0; i < 100; i++) {
        const event = engine.generate()
        assert.equal(event.message, 'always', `Expected "always" but got "${event.message}"`)
      }
    })

    it('respects relative weights', () => {
      const engine = new TemplateEngine(
        makeConfig({
          templates: [
            { message: 'common', level: 'info', weight: 99 },
            { message: 'rare', level: 'warn', weight: 1 },
          ],
        }),
      )

      let commonCount = 0
      const iterations = 1000
      for (let i = 0; i < iterations; i++) {
        if (engine.generate().message === 'common') commonCount++
      }

      // Should be overwhelmingly "common"
      assert.ok(
        commonCount > iterations * 0.85,
        `Expected mostly "common", got ${commonCount}/${iterations}`,
      )
    })

    it('defaults weight to 1', () => {
      const engine = new TemplateEngine(
        makeConfig({
          templates: [
            { message: 'a', level: 'info' },
            { message: 'b', level: 'info' },
          ],
        }),
      )

      const counts = { a: 0, b: 0 }
      for (let i = 0; i < 1000; i++) {
        const msg = engine.generate().message as string
        if (msg === 'a') counts.a++
        if (msg === 'b') counts.b++
      }

      // Both should appear (roughly 50/50 with default weight 1)
      assert.ok(counts.a > 300, `Expected "a" to appear often, got ${counts.a}`)
      assert.ok(counts.b > 300, `Expected "b" to appear often, got ${counts.b}`)
    })
  })

  describe('placeholder resolution', () => {
    it('resolves {{placeholder}} in messages', () => {
      const engine = new TemplateEngine(
        makeConfig({
          generators: {
            orderId: { type: 'sequence', prefix: 'ORD-', start: 1 },
          },
          templates: [{ message: 'Processing order {{orderId}}', level: 'info' }],
        }),
      )

      const event = engine.generate()
      assert.equal(event.message, 'Processing order ORD-1')
    })

    it('resolves multiple placeholders', () => {
      const engine = new TemplateEngine(
        makeConfig({
          generators: {
            user: { type: 'choice', values: ['alice'] },
            action: { type: 'choice', values: ['login'] },
          },
          templates: [{ message: 'User {{user}} performed {{action}}', level: 'info' }],
        }),
      )

      const event = engine.generate()
      assert.equal(event.message, 'User alice performed login')
    })
  })

  describe('field resolution with $gen', () => {
    it('resolves $gen references in fields', () => {
      const engine = new TemplateEngine(
        makeConfig({
          generators: {
            statusCode: { type: 'choice', values: [200] },
            latency: { type: 'float', min: 1.5, max: 1.5, decimals: 1 },
          },
          templates: [
            {
              message: 'Request completed',
              level: 'info',
              fields: {
                status_code: { $gen: 'statusCode' },
                latency_ms: { $gen: 'latency' },
                static_field: 'constant',
              },
            },
          ],
        }),
      )

      const event = engine.generate()
      assert.equal(event.status_code, 200)
      assert.equal(event.latency_ms, 1.5)
      assert.equal(event.static_field, 'constant')
    })
  })

  describe('template-scoped generators', () => {
    it('uses template-level generator overrides', () => {
      const engine = new TemplateEngine(
        makeConfig({
          generators: {
            env: { type: 'choice', values: ['prod'] },
          },
          templates: [
            {
              message: 'In {{env}}',
              level: 'info',
              weight: 100,
              generators: {
                env: { type: 'choice', values: ['staging'] },
              },
            },
          ],
        }),
      )

      const event = engine.generate()
      assert.equal(event.message, 'In staging')
    })
  })

  describe('spike activation', () => {
    it('adds extra templates during spike', () => {
      const config = makeConfig({
        templates: [{ message: 'normal', level: 'info', weight: 0 }],
        spike: {
          extra_templates: [{ message: 'spike-only', level: 'error', weight: 100 }],
        },
      })

      const engine = new TemplateEngine(config)

      // Before spike — only normal template (weight 0 means very unlikely but only option)
      const beforeEvent = engine.generate()
      assert.equal(beforeEvent.message, 'normal')

      // Activate spike — extra template dominates
      engine.activateSpike()
      let spikeCount = 0
      for (let i = 0; i < 50; i++) {
        if (engine.generate().message === 'spike-only') spikeCount++
      }
      assert.ok(spikeCount > 40, `Expected spike template to dominate, got ${spikeCount}/50`)
    })

    it('applies error weight multiplier', () => {
      const config = makeConfig({
        templates: [
          { message: 'info-msg', level: 'info', weight: 10 },
          { message: 'error-msg', level: 'error', weight: 10 },
        ],
        spike: {
          error_weight_multiplier: 100,
        },
      })

      const engine = new TemplateEngine(config)
      engine.activateSpike()

      let errorCount = 0
      const iterations = 500
      for (let i = 0; i < iterations; i++) {
        if (engine.generate().message === 'error-msg') errorCount++
      }

      // With multiplier 100, error weight is 1000 vs info weight 10
      // Error should be ~99% of results
      assert.ok(
        errorCount > iterations * 0.9,
        `Expected error to dominate, got ${errorCount}/${iterations}`,
      )
    })

    it('reverts on deactivateSpike()', () => {
      const config = makeConfig({
        templates: [
          { message: 'normal', level: 'info', weight: 100 },
          { message: 'error-msg', level: 'error', weight: 1 },
        ],
        spike: {
          extra_templates: [{ message: 'spike-only', level: 'error', weight: 1000 }],
        },
      })

      const engine = new TemplateEngine(config)
      engine.activateSpike()
      engine.deactivateSpike()

      // After deactivation, spike-only template should not appear
      for (let i = 0; i < 50; i++) {
        const msg = engine.generate().message
        assert.notEqual(msg, 'spike-only', 'spike-only template should not appear after deactivate')
      }
    })
  })

  describe('error storm', () => {
    it('boosts error templates to ~50% of total weight', () => {
      const config = makeConfig({
        templates: [
          { message: 'info-msg', level: 'info', weight: 90 },
          { message: 'error-msg', level: 'error', weight: 10 },
        ],
      })

      const engine = new TemplateEngine(config)
      engine.activateErrorStorm()

      let errorCount = 0
      const iterations = 1000
      for (let i = 0; i < iterations; i++) {
        if (engine.generate().level === 'error') errorCount++
      }

      // Should be approximately 50%
      const ratio = errorCount / iterations
      assert.ok(
        ratio > 0.35 && ratio < 0.65,
        `Expected ~50% errors, got ${(ratio * 100).toFixed(1)}%`,
      )
    })

    it('reverts on deactivateErrorStorm()', () => {
      const config = makeConfig({
        templates: [
          { message: 'info-msg', level: 'info', weight: 90 },
          { message: 'error-msg', level: 'error', weight: 10 },
        ],
      })

      const engine = new TemplateEngine(config)
      engine.activateErrorStorm()
      engine.deactivateErrorStorm()

      let errorCount = 0
      const iterations = 1000
      for (let i = 0; i < iterations; i++) {
        if (engine.generate().level === 'error') errorCount++
      }

      // Should revert to original 10% error ratio
      const ratio = errorCount / iterations
      assert.ok(ratio < 0.25, `Expected ~10% errors after revert, got ${(ratio * 100).toFixed(1)}%`)
    })
  })
})
