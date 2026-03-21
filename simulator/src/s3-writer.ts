import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

export interface S3WriterConfig {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
}

/**
 * Batches log events and writes them to S3 as .jsonl files.
 * Partitions by {service}/{year}/{month}/{day}/{hour}/.
 */
export class S3Writer {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly buffers = new Map<string, unknown[]>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private fileCounter = 0

  constructor(config: S3WriterConfig) {
    this.bucket = config.bucket
    this.client = new S3Client({
      region: config.region ?? 'us-east-1',
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  /** Add an event to the buffer. Returns the expected S3 key for source_ref. */
  addEvent(service: string, event: Record<string, unknown>): string {
    const key = this.currentPrefix(service)
    const existing = this.buffers.get(key)
    if (existing) {
      existing.push(event)
    } else {
      this.buffers.set(key, [event])
    }
    return key
  }

  /** Start periodic flushing (default: every 5 seconds). */
  startFlushing(intervalMs = 5000): void {
    this.flushTimer = setInterval(() => {
      this.flushAll().catch((err) => {
        console.error(`[S3Writer] Flush failed: ${err}`)
      })
    }, intervalMs)
  }

  /** Flush all buffered events to S3. */
  async flushAll(): Promise<void> {
    const entries = [...this.buffers.entries()]
    this.buffers.clear()

    for (const [prefix, events] of entries) {
      if (events.length === 0) continue
      await this.writeFile(prefix, events)
    }
  }

  /** Stop flushing and write remaining events. */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flushAll()
    this.client.destroy()
  }

  private currentPrefix(service: string): string {
    const now = new Date()
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    const day = String(now.getUTCDate()).padStart(2, '0')
    const hour = String(now.getUTCHours()).padStart(2, '0')
    return `logs/${service}/${year}/${month}/${day}/${hour}/`
  }

  private async writeFile(prefix: string, events: unknown[]): Promise<void> {
    this.fileCounter++
    const key = `${prefix}batch-${this.fileCounter}-${Date.now()}.jsonl`
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n'

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/x-ndjson',
      }),
    )

    console.log(`[S3Writer] Wrote ${events.length} events to s3://${this.bucket}/${key}`)
  }
}
