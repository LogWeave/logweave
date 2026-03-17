import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GeneratorRegistry, resolveFieldValue } from '../src/generator.js'

describe('GeneratorRegistry', () => {
  describe('choice generator', () => {
    it('picks from the provided values', () => {
      const registry = new GeneratorRegistry({
        color: { type: 'choice', values: ['red', 'green', 'blue'] },
      })

      const results = new Set<unknown>()
      for (let i = 0; i < 100; i++) {
        results.add(registry.resolve('color'))
      }

      // With 100 tries and 3 values, we should see at least 2 distinct values
      assert.ok(results.size >= 2, `Expected at least 2 distinct values, got ${results.size}`)
      for (const val of results) {
        assert.ok(
          ['red', 'green', 'blue'].includes(val as string),
          `Unexpected value: ${String(val)}`,
        )
      }
    })
  })

  describe('weighted_choice generator', () => {
    it('respects weights', () => {
      const registry = new GeneratorRegistry({
        status: {
          type: 'weighted_choice',
          values: [
            { value: 'common', weight: 1000 },
            { value: 'rare', weight: 1 },
          ],
        },
      })

      let commonCount = 0
      const iterations = 500
      for (let i = 0; i < iterations; i++) {
        if (registry.resolve('status') === 'common') commonCount++
      }

      // With weight 1000 vs 1, the vast majority should be 'common'
      assert.ok(
        commonCount > iterations * 0.9,
        `Expected mostly "common" results, got ${commonCount}/${iterations}`,
      )
    })
  })

  describe('int generator', () => {
    it('stays within min/max range', () => {
      const registry = new GeneratorRegistry({
        port: { type: 'int', min: 3000, max: 3010 },
      })

      for (let i = 0; i < 200; i++) {
        const val = registry.resolve('port') as number
        assert.ok(val >= 3000, `Value ${val} below min 3000`)
        assert.ok(val <= 3010, `Value ${val} above max 3010`)
        assert.equal(val, Math.floor(val), 'int generator must produce integers')
      }
    })

    it('can produce both min and max values', () => {
      const registry = new GeneratorRegistry({
        small: { type: 'int', min: 0, max: 1 },
      })

      const seen = new Set<number>()
      for (let i = 0; i < 100; i++) {
        seen.add(registry.resolve('small') as number)
      }
      assert.ok(seen.has(0), 'Should be able to produce min value')
      assert.ok(seen.has(1), 'Should be able to produce max value')
    })
  })

  describe('float generator', () => {
    it('stays within min/max range', () => {
      const registry = new GeneratorRegistry({
        latency: { type: 'float', min: 0.5, max: 2.5, decimals: 3 },
      })

      for (let i = 0; i < 100; i++) {
        const val = registry.resolve('latency') as number
        assert.ok(val >= 0.5, `Value ${val} below min 0.5`)
        assert.ok(val <= 2.5, `Value ${val} above max 2.5`)
      }
    })

    it('has correct decimal places', () => {
      const registry = new GeneratorRegistry({
        precise: { type: 'float', min: 0, max: 10, decimals: 4 },
      })

      for (let i = 0; i < 50; i++) {
        const val = registry.resolve('precise') as number
        const parts = String(val).split('.')
        // Decimals may have trailing zeros stripped, so length should be <= decimals
        if (parts.length === 2) {
          const decimals = parts[1] ?? ''
          assert.ok(
            decimals.length <= 4,
            `Expected at most 4 decimal places, got ${decimals.length} in ${val}`,
          )
        }
      }
    })

    it('defaults to 2 decimal places', () => {
      const registry = new GeneratorRegistry({
        val: { type: 'float', min: 0, max: 100 },
      })

      for (let i = 0; i < 50; i++) {
        const val = registry.resolve('val') as number
        const parts = String(val).split('.')
        if (parts.length === 2) {
          const decimals = parts[1] ?? ''
          assert.ok(decimals.length <= 2, `Expected at most 2 decimal places, got ${val}`)
        }
      }
    })
  })

  describe('uuid generator', () => {
    it('produces valid UUID format', () => {
      const registry = new GeneratorRegistry()
      const uuid = registry.resolve('uuid') as string
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      assert.match(uuid, uuidRegex, `"${uuid}" is not a valid UUID`)
    })

    it('produces unique values', () => {
      const registry = new GeneratorRegistry()
      const a = registry.resolve('uuid')
      const b = registry.resolve('uuid')
      assert.notEqual(a, b, 'UUIDs should be unique')
    })
  })

  describe('ip generator', () => {
    it('produces valid private IPs', () => {
      const registry = new GeneratorRegistry()
      const ipRegex = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/

      for (let i = 0; i < 50; i++) {
        const ip = registry.resolve('ip') as string
        assert.match(ip, ipRegex, `"${ip}" is not a valid private IP`)
      }
    })
  })

  describe('email generator', () => {
    it('produces valid email format', () => {
      const registry = new GeneratorRegistry()
      const emailRegex = /^\w+@\w+\.\w+$/

      for (let i = 0; i < 20; i++) {
        const email = registry.resolve('email') as string
        assert.match(email, emailRegex, `"${email}" is not a valid email`)
      }
    })
  })

  describe('sequence generator', () => {
    it('auto-increments from start value', () => {
      const registry = new GeneratorRegistry({
        orderId: { type: 'sequence', prefix: 'ORD-', start: 100 },
      })

      assert.equal(registry.resolve('orderId'), 'ORD-100')
      assert.equal(registry.resolve('orderId'), 'ORD-101')
      assert.equal(registry.resolve('orderId'), 'ORD-102')
    })

    it('defaults start to 1', () => {
      const registry = new GeneratorRegistry({
        reqId: { type: 'sequence', prefix: 'REQ-' },
      })

      assert.equal(registry.resolve('reqId'), 'REQ-1')
      assert.equal(registry.resolve('reqId'), 'REQ-2')
    })
  })

  describe('timestamp generator', () => {
    it('produces ISO 8601 timestamps', () => {
      const registry = new GeneratorRegistry()
      const ts = registry.resolve('timestamp') as string
      // Should be parseable as a date
      const parsed = new Date(ts)
      assert.ok(!Number.isNaN(parsed.getTime()), `"${ts}" is not a valid timestamp`)
      // Should be ISO format
      assert.ok(ts.endsWith('Z'), `Timestamp should end with Z: ${ts}`)
    })
  })

  describe('child registry', () => {
    it('overrides parent generators', () => {
      const parent = new GeneratorRegistry({
        env: { type: 'choice', values: ['prod'] },
      })

      const child = parent.child({
        env: { type: 'choice', values: ['staging'] },
      })

      assert.equal(child.resolve('env'), 'staging')
      assert.equal(parent.resolve('env'), 'prod')
    })

    it('inherits parent generators', () => {
      const parent = new GeneratorRegistry({
        region: { type: 'choice', values: ['us-east-1'] },
      })

      const child = parent.child({
        extra: { type: 'choice', values: ['bonus'] },
      })

      assert.equal(child.resolve('region'), 'us-east-1')
      assert.equal(child.resolve('extra'), 'bonus')
    })

    it('shares sequence state with parent', () => {
      const parent = new GeneratorRegistry({
        seq: { type: 'sequence', prefix: 'S-', start: 1 },
      })

      assert.equal(parent.resolve('seq'), 'S-1')

      const child = parent.child({})
      assert.equal(child.resolve('seq'), 'S-2')
      assert.equal(parent.resolve('seq'), 'S-3')
    })
  })

  describe('unknown generator', () => {
    it('throws for unregistered names', () => {
      const registry = new GeneratorRegistry()
      assert.throws(() => registry.resolve('nonexistent'), /Unknown generator: "nonexistent"/)
    })
  })
})

describe('resolveFieldValue', () => {
  it('resolves $gen references', () => {
    const registry = new GeneratorRegistry({
      status: { type: 'choice', values: [200] },
    })

    const result = resolveFieldValue({ $gen: 'status' }, registry)
    assert.equal(result, 200)
  })

  it('returns plain values as-is', () => {
    const registry = new GeneratorRegistry()

    assert.equal(resolveFieldValue(42, registry), 42)
    assert.equal(resolveFieldValue('hello', registry), 'hello')
    assert.equal(resolveFieldValue(null, registry), null)
    assert.equal(resolveFieldValue(true, registry), true)
  })

  it('returns non-$gen objects as-is', () => {
    const registry = new GeneratorRegistry()
    const obj = { key: 'value' }
    assert.deepEqual(resolveFieldValue(obj, registry), obj)
  })

  it('returns arrays as-is', () => {
    const registry = new GeneratorRegistry()
    const arr = [1, 2, 3]
    assert.deepEqual(resolveFieldValue(arr, registry), arr)
  })
})
