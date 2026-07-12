/**
 * Test/no-op implementations of the {@link ArchiveSink} seam (issue #266).
 *
 * These let the ingest and transform engines be exercised without real S3
 * wiring (that lands in issue #273/#275). No production behaviour depends on
 * them.
 */

import type { ArchiveSink } from './contracts.js'

/**
 * In-memory {@link ArchiveSink} that retains every put for inspection — the
 * default fake for tests that need to assert what was archived and under which
 * key. Last-writer-wins on `objectKey` (matching real S3): a repeat key
 * overwrites, so an identical-bytes replay leaves exactly one object.
 */
export class InMemoryArchiveSink implements ArchiveSink {
  private readonly objects = new Map<string, Uint8Array>()

  put(objectKey: string, bytes: Uint8Array): Promise<void> {
    // Copy so later mutation of the caller's buffer can't alter stored bytes.
    this.objects.set(objectKey, bytes.slice())
    return Promise.resolve()
  }

  /** Retrieve previously archived bytes, or undefined if the key is absent. */
  get(objectKey: string): Uint8Array | undefined {
    return this.objects.get(objectKey)
  }

  /** Keys of all archived objects, in insertion order. */
  keys(): string[] {
    return [...this.objects.keys()]
  }

  /** Number of distinct archived objects. */
  get size(): number {
    return this.objects.size
  }

  /** Drop all retained objects. */
  clear(): void {
    this.objects.clear()
  }
}

/**
 * No-op {@link ArchiveSink} that durably stores nothing and always succeeds.
 * For tests and contexts where archival is intentionally disabled and the put
 * result is irrelevant. Do NOT use where the 2xx is gated on real durability.
 */
export class NoopArchiveSink implements ArchiveSink {
  put(): Promise<void> {
    return Promise.resolve()
  }
}
