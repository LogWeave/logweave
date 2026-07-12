import { LogWeaveTransport } from '../../packages/transport/src/transport.js'
import { deriveApiBase, postDeployMarker } from './deploy-marker.js'
import { S3Writer } from './s3-writer.js'
import { ModeController, Scheduler } from './scheduler.js'
import { TemplateEngine } from './template-engine.js'
import type { CliOptions, DefaultsConfig, ServiceConfig } from './types.js'

interface RunnerDeps {
  services: ServiceConfig[]
  options: CliOptions
  defaults: DefaultsConfig
}

export class Runner {
  private readonly transports: LogWeaveTransport[] = []
  private readonly engines: TemplateEngine[] = []
  private readonly scheduler: Scheduler
  private readonly modeController: ModeController
  private readonly options: CliOptions
  private readonly s3Writer: S3Writer | null = null
  /** Cumulative weight array for weighted service selection */
  private readonly serviceWeights: number[]
  private readonly totalServiceWeight: number
  private eventCount = 0
  private startTime = 0

  constructor({ services, options, defaults }: RunnerDeps) {
    this.options = options

    if (options.s3Bucket) {
      this.s3Writer = new S3Writer({
        endpoint: options.s3Endpoint ?? 'http://localhost:4566',
        bucket: options.s3Bucket,
        accessKeyId: 'test',
        secretAccessKey: 'test',
      })
    }

    for (const svc of services) {
      const engine = new TemplateEngine(svc)
      this.engines.push(engine)

      if (!options.dryRun) {
        const transport = new LogWeaveTransport({
          apiKey: options.apiKey,
          service: svc.service,
          endpoint: options.endpoint,
          environment: svc.environment ?? 'production',
          bufferSize: options.bufferSize,
          flushIntervalMs: options.flushMs,
          timeoutMs: 10_000,
          maxRetries: 3,
          onDrop: (events, error) => {
            console.error(`[${svc.service}] Dropped ${events.length} events: ${error.message}`)
          },
        })
        this.transports.push(transport)
      }
    }

    // Build cumulative weight array for weighted service selection
    let cumWeight = 0
    this.serviceWeights = services.map((svc) => {
      cumWeight += svc.rate_weight ?? 1
      return cumWeight
    })
    this.totalServiceWeight = cumWeight

    this.scheduler = new Scheduler(
      options.rate,
      () => {
        this.emitEvent()
      },
      options.diurnal,
    )

    this.modeController = new ModeController(
      options.mode,
      defaults.mode_timings,
      this.engines,
      this.scheduler,
      options.rate,
    )

    // The canonical "deploying" service for deploy markers — the first with a
    // spike config (its spike is the simulated deploy). null if none.
    this.deployService = services.find((s) => s.spike)?.service ?? null

    // Each time we enter deploy-spike, register a deploy marker so LogWeave's
    // deploy-anchored change detection has something to anchor to.
    this.modeController.on('modeChange', (event: { mode: string }) => {
      if (event.mode === 'deploy-spike') void this.registerDeploy()
    })
  }

  private readonly deployService: string | null
  private deployVersion = 0

  /** Best-effort deploy marker for the current deploy-spike. No-op in dry-run. */
  private async registerDeploy(): Promise<void> {
    if (this.options.dryRun || !this.deployService) return
    this.deployVersion++
    await postDeployMarker(deriveApiBase(this.options.endpoint), this.options.apiKey, {
      service: this.deployService,
      version: `sim-1.${this.deployVersion}.0`,
    })
  }

  private stopped = false
  private durationTimer: ReturnType<typeof setTimeout> | null = null

  /** Pick a service index using weighted random selection */
  private pickService(): number {
    const roll = Math.random() * this.totalServiceWeight
    for (let i = 0; i < this.serviceWeights.length; i++) {
      if ((this.serviceWeights[i] ?? 0) > roll) return i
    }
    return this.serviceWeights.length - 1
  }

  private emitEvent(): void {
    const idx = this.pickService()
    const engine = this.engines[idx]
    if (!engine) return

    let event: ReturnType<TemplateEngine['generate']>
    try {
      event = engine.generate()
    } catch (err) {
      console.error(`[${engine.serviceName}] Event generation failed: ${err}`)
      return
    }
    this.eventCount++

    if (this.options.dryRun) {
      const svc = this.engines[idx]?.serviceName ?? 'unknown'
      const level = String(event.level)
      const levelColor = levelColors[level] ?? '\x1b[0m'
      console.log(
        `\x1b[90m${event.timestamp}\x1b[0m ${levelColor}${level.toUpperCase().padEnd(5)}\x1b[0m \x1b[36m[${svc}]\x1b[0m ${event.message}`,
      )
      return
    }

    const transport = this.transports[idx]
    if (!transport) return

    // Dual-write: also write to S3 if enabled
    const serviceName = engine.serviceName
    if (this.s3Writer) {
      this.s3Writer.addEvent(serviceName, {
        message: event.message,
        level: event.level,
        timestamp: event.timestamp,
        ...event,
      })
    }

    transport.write(
      {
        level: event.level,
        message: event.message,
        timestamp: event.timestamp,
        ...event,
        [Symbol.for('level')]: event.level,
      },
      () => {},
    )
  }

  start(): void {
    this.startTime = Date.now()
    const serviceNames = this.engines.map((e) => e.serviceName).join(', ')

    console.log(`\x1b[1mLogWeave Simulator\x1b[0m`)
    console.log(`  Services: ${serviceNames}`)
    console.log(`  Rate:     ${this.options.rate} events/sec`)
    console.log(`  Mode:     ${this.options.mode}`)
    console.log(`  Endpoint: ${this.options.dryRun ? '(dry-run)' : this.options.endpoint}`)
    console.log(`  S3:       ${this.s3Writer ? `s3://${this.options.s3Bucket}` : '(disabled)'}`)
    console.log(
      `  Duration: ${this.options.duration === 0 ? 'indefinite' : `${this.options.duration}s`}`,
    )
    console.log('')

    this.scheduler.start()
    this.modeController.start()
    // Initial-mode deploy-spike doesn't emit a modeChange, so mark it here.
    if (this.options.mode === 'deploy-spike') void this.registerDeploy()
    this.s3Writer?.startFlushing()

    if (this.options.duration > 0) {
      this.durationTimer = setTimeout(() => {
        this.stop()
      }, this.options.duration * 1000)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true

    if (this.durationTimer) {
      clearTimeout(this.durationTimer)
      this.durationTimer = null
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1)
    console.log(`\n\x1b[1mShutting down...\x1b[0m`)

    this.scheduler.stop()
    this.modeController.stop()

    await Promise.all([...this.transports.map((t) => t.closeAsync()), this.s3Writer?.close()])

    console.log(`  Events sent: ${this.eventCount}`)
    console.log(`  Duration:    ${elapsed}s`)
    console.log(
      `  Avg rate:    ${(this.eventCount / (Number(elapsed) || 1)).toFixed(1)} events/sec`,
    )
  }
}

const levelColors: Record<string, string> = {
  debug: '\x1b[90m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
}
