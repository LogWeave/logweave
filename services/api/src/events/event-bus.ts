import type { TailEvent } from '../tail/types.js'

/**
 * EventBus — decouples event publishing from the TailBuffer ring buffer.
 *
 * The ingest pipeline publishes events through this interface. In single-instance
 * mode, LocalEventBus pushes directly to TailBuffer. In multi-instance mode
 * (future), NatsEventBus publishes to NATS JetStream for cross-instance broadcast.
 *
 * SSE connections and MCP polling still read from TailBuffer directly — EventBus
 * is publish-only.
 */
export interface EventBus {
  /** Publish a tail event for a tenant. Fire-and-forget, never throws. */
  publishTailEvent(tenantId: string, event: Omit<TailEvent, 'seq'>): void

  /** Is the bus connected and operational? */
  isConnected(): boolean

  /** Graceful shutdown. */
  close(): Promise<void>
}
