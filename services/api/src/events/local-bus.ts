import type { TailBuffer } from '../tail/buffer.js'
import type { TailEvent } from '../tail/types.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'
import type { EventBus } from './event-bus.js'

/**
 * LocalEventBus — single-instance implementation of EventBus.
 *
 * Pushes events directly to the in-process TailBuffer. Handles tail mode
 * filtering (disabled/metadata/preprocessed) so the ingest pipeline doesn't
 * need to know about tail modes.
 */
export class LocalEventBus implements EventBus {
  private readonly tailBuffer: TailBuffer
  private readonly settingsStore: TenantSettingsStore

  constructor(tailBuffer: TailBuffer, settingsStore: TenantSettingsStore) {
    this.tailBuffer = tailBuffer
    this.settingsStore = settingsStore
  }

  publishTailEvent(tenantId: string, event: Omit<TailEvent, 'seq'>): void {
    const tailMode = this.settingsStore.get(tenantId).tailMode
    if (!tailMode || tailMode === 'disabled') return

    const filtered =
      tailMode === 'preprocessed' ? event : { ...event, preProcessedMessage: undefined }
    this.tailBuffer.push(tenantId, filtered)
  }

  isConnected(): boolean {
    return true
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
