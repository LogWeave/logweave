import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildSystemNotes, formatSystemStateBlock } from '../src/shared/system-state.js'

describe('buildSystemNotes', () => {
  it('returns empty when scorer is steady and no changes meta', () => {
    const notes = buildSystemNotes({ phase: 'steady', warmupRemainingMs: 0 }, null)
    assert.deepEqual(notes, [])
  })

  it('returns empty when scorer state is unknown (no events)', () => {
    const notes = buildSystemNotes({ phase: 'unknown', warmupRemainingMs: 0 }, null)
    assert.deepEqual(notes, [])
  })

  it('adds a cold-start note when scorer is in cold-start', () => {
    const notes = buildSystemNotes({ phase: 'cold-start', warmupRemainingMs: 9 * 60_000 }, null)
    assert.equal(notes.length, 1)
    assert.match(notes[0]!, /cold-start/i)
    assert.match(notes[0]!, /INSUFFICIENT_DATA/i)
    assert.match(notes[0]!, /9/) // remaining minutes
  })

  it('adds a warmup note when scorer is warming up', () => {
    const notes = buildSystemNotes({ phase: 'warmup', warmupRemainingMs: 45 * 60_000 }, null)
    assert.equal(notes.length, 1)
    assert.match(notes[0]!, /warming up/i)
    assert.match(notes[0]!, /10x/) // threshold info
    assert.match(notes[0]!, /45/)
  })

  it('adds an empty-baseline note when changes meta says baselineStatus=empty', () => {
    const notes = buildSystemNotes(null, {
      baselineStatus: 'empty',
      previousWindowEvents: 0,
    })
    assert.equal(notes.length, 1)
    assert.match(notes[0]!, /Baseline window.*empty/i)
    assert.match(notes[0]!, /we have no baseline/i)
  })

  it('adds a sparse-baseline note when changes meta says baselineStatus=sparse', () => {
    const notes = buildSystemNotes(null, {
      baselineStatus: 'sparse',
      previousWindowEvents: 25,
    })
    assert.equal(notes.length, 1)
    assert.match(notes[0]!, /sparse/i)
    assert.match(notes[0]!, /25/)
  })

  it('does not add notes when baselineStatus=ok', () => {
    const notes = buildSystemNotes(null, {
      baselineStatus: 'ok',
      previousWindowEvents: 5000,
    })
    assert.deepEqual(notes, [])
  })

  it('combines anomaly + baseline notes when both apply', () => {
    const notes = buildSystemNotes(
      { phase: 'warmup', warmupRemainingMs: 30 * 60_000 },
      { baselineStatus: 'empty', previousWindowEvents: 0 },
    )
    assert.equal(notes.length, 2)
  })
})

describe('formatSystemStateBlock', () => {
  it('returns empty string when no notes', () => {
    assert.equal(formatSystemStateBlock([]), '')
  })

  it('formats a markdown System state block with bullet list', () => {
    const block = formatSystemStateBlock(['First note.', 'Second note.'])
    assert.match(block, /System state/)
    assert.match(block, /- First note\./)
    assert.match(block, /- Second note\./)
    assert.ok(block.startsWith('\n---\n'), 'should start with markdown separator')
  })
})
