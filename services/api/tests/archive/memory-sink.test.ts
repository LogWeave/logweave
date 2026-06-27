import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ArchiveSink } from '../../src/archive/contracts.js'
import { InMemoryArchiveSink, NoopArchiveSink } from '../../src/archive/memory-sink.js'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array | undefined): string | undefined =>
  b === undefined ? undefined : new TextDecoder().decode(b)

// ---------------------------------------------------------------------------
// InMemoryArchiveSink
// ---------------------------------------------------------------------------

describe('InMemoryArchiveSink', () => {
  it('satisfies the ArchiveSink contract', () => {
    // Compile-time + runtime check that it is assignable to the seam type.
    const sink: ArchiveSink = new InMemoryArchiveSink()
    assert.equal(typeof sink.put, 'function')
  })

  it('retains put bytes retrievable by key', async () => {
    const sink = new InMemoryArchiveSink()
    await sink.put('tenant/a/2026/object-1.ndjson.gz', bytes('hello'))

    assert.equal(text(sink.get('tenant/a/2026/object-1.ndjson.gz')), 'hello')
    assert.equal(sink.size, 1)
    assert.deepEqual(sink.keys(), ['tenant/a/2026/object-1.ndjson.gz'])
  })

  it('returns undefined for an absent key', () => {
    const sink = new InMemoryArchiveSink()
    assert.equal(sink.get('missing'), undefined)
  })

  it('is idempotent on objectKey — a replay leaves exactly one object', async () => {
    const sink = new InMemoryArchiveSink()
    await sink.put('k', bytes('v1'))
    await sink.put('k', bytes('v1'))

    assert.equal(sink.size, 1)
    assert.equal(text(sink.get('k')), 'v1')
  })

  it('copies bytes so later mutation of the caller buffer cannot alter storage', async () => {
    const sink = new InMemoryArchiveSink()
    const buf = bytes('original')
    await sink.put('k', buf)
    buf[0] = 0 // mutate caller's buffer after the put

    assert.equal(text(sink.get('k')), 'original')
  })

  it('clear() drops all retained objects', async () => {
    const sink = new InMemoryArchiveSink()
    await sink.put('a', bytes('1'))
    await sink.put('b', bytes('2'))
    sink.clear()

    assert.equal(sink.size, 0)
    assert.deepEqual(sink.keys(), [])
  })
})

// ---------------------------------------------------------------------------
// NoopArchiveSink
// ---------------------------------------------------------------------------

describe('NoopArchiveSink', () => {
  it('resolves put without storing anything', async () => {
    const sink: ArchiveSink = new NoopArchiveSink()
    await assert.doesNotReject(sink.put('k', bytes('v')))
  })
})
