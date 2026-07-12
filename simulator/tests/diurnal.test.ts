import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseArgs } from '../src/cli.js'
import { deriveApiBase } from '../src/deploy-marker.js'
import { diurnalFactor, diurnalFactorAt } from '../src/diurnal.js'

describe('diurnalFactor', () => {
  it('peaks at 1.0 around 14:00 UTC', () => {
    assert.ok(Math.abs(diurnalFactor(14) - 1.0) < 1e-9)
  })

  it('troughs at the floor (~0.2) around 02:00 UTC', () => {
    assert.ok(Math.abs(diurnalFactor(2) - 0.2) < 1e-9)
  })

  it('stays within [0.2, 1.0] for every hour', () => {
    for (let h = 0; h < 24; h++) {
      const f = diurnalFactor(h)
      assert.ok(f >= 0.2 - 1e-9 && f <= 1.0 + 1e-9, `hour ${h} → ${f}`)
    }
  })

  it('rises from trough toward peak through the morning', () => {
    // 02:00 (trough) < 08:00 < 14:00 (peak)
    assert.ok(diurnalFactor(2) < diurnalFactor(8))
    assert.ok(diurnalFactor(8) < diurnalFactor(14))
  })

  it('diurnalFactorAt uses fractional UTC hour of the instant', () => {
    const peak = new Date(Date.UTC(2026, 0, 1, 14, 0, 0))
    const trough = new Date(Date.UTC(2026, 0, 1, 2, 0, 0))
    assert.ok(diurnalFactorAt(peak) > diurnalFactorAt(trough))
  })
})

describe('deriveApiBase', () => {
  it('strips the /ingest/batch suffix to get the API base', () => {
    assert.equal(deriveApiBase('http://localhost:3000/v1/ingest/batch'), 'http://localhost:3000/v1')
  })

  it('tolerates a trailing slash', () => {
    assert.equal(
      deriveApiBase('http://localhost:3000/v1/ingest/batch/'),
      'http://localhost:3000/v1',
    )
  })
})

describe('parseArgs — backfill/diurnal flags', () => {
  it('defaults backfill off and diurnal off', () => {
    const o = parseArgs(['--api-key', 'k'])
    assert.equal(o.backfillDays, 0)
    assert.equal(o.diurnal, false)
    assert.equal(o.backfillRate, 2)
  })

  it('parses --backfill, --backfill-rate and --diurnal', () => {
    const o = parseArgs(['--backfill', '7', '--backfill-rate', '5', '--diurnal'])
    assert.equal(o.backfillDays, 7)
    assert.equal(o.backfillRate, 5)
    assert.equal(o.diurnal, true)
  })

  it('rejects a negative --backfill', () => {
    assert.throws(() => parseArgs(['--backfill', '-1']))
  })

  it('rejects a non-positive --backfill-rate', () => {
    assert.throws(() => parseArgs(['--backfill-rate', '0']))
  })
})
