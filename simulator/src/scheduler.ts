import { EventEmitter } from 'node:events'
import { diurnalFactorAt } from './diurnal.js'
import type { TemplateEngine } from './template-engine.js'
import type { DefaultsConfig, Mode } from './types.js'

/**
 * Poisson-process event scheduler. Emits events at a target rate
 * with exponentially distributed inter-arrival times.
 *
 * The callback receives an ever-incrementing serviceIndex.
 * Callers are responsible for mapping it to actual services (e.g. via modulo).
 */
export class Scheduler {
  private rate: number
  private readonly onEvent: (serviceIndex: number) => void
  private readonly diurnal: boolean
  private currentIndex = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(rate: number, onEvent: (serviceIndex: number) => void, diurnal = false) {
    this.rate = rate
    this.onEvent = onEvent
    this.diurnal = diurnal
  }

  /** Start emitting events at the configured rate */
  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleNext()
  }

  /** Stop emitting events */
  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Dynamically adjust the event rate */
  setRate(newRate: number): void {
    this.rate = newRate
  }

  /** Whether the scheduler is currently running */
  get isRunning(): boolean {
    return this.running
  }

  private scheduleNext(): void {
    if (!this.running) return

    // Poisson inter-arrival time: exponential distribution.
    // Clamp random away from 0 to avoid Math.log(0) = -Infinity.
    // When diurnal shaping is on, scale the rate by the current hour-of-day so
    // live traffic has the same daily rhythm the baselines learn from.
    const effectiveRate = this.diurnal
      ? Math.max(Number.EPSILON, this.rate * diurnalFactorAt(new Date()))
      : this.rate
    const r = Math.max(Number.EPSILON, Math.random())
    const delay = Math.min(10_000, Math.max(1, -Math.log(r) * (1000 / effectiveRate)))

    this.timer = setTimeout(() => {
      if (!this.running) return

      this.onEvent(this.currentIndex)
      this.currentIndex++

      this.scheduleNext()
    }, delay)
  }
}

/** Events emitted by the ModeController */
export interface ModeChangeEvent {
  mode: Mode
  previousMode: Mode
}

/**
 * Controls mode transitions for the simulator.
 * Directly manages TemplateEngine spike/storm activation and Scheduler rate.
 * In chaos mode, alternates between steady periods and random events
 * (spike, storm, quiet) on a timer.
 */
export class ModeController extends EventEmitter {
  private readonly timings: DefaultsConfig['mode_timings']
  private readonly engines: TemplateEngine[]
  private readonly scheduler: Scheduler
  private readonly baseRate: number
  private currentMode: Mode
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(
    initialMode: Mode,
    timings: DefaultsConfig['mode_timings'],
    engines: TemplateEngine[],
    scheduler: Scheduler,
    baseRate: number,
  ) {
    super()
    this.currentMode = initialMode
    this.timings = timings
    this.engines = engines
    this.scheduler = scheduler
    this.baseRate = baseRate
  }

  /** Start mode transitions. Applies initial mode and schedules chaos transitions if needed. */
  start(): void {
    if (this.running) return
    this.running = true

    if (this.currentMode === 'chaos') {
      this.scheduleChaosTransition()
    } else {
      // Apply the initial mode effects (e.g. deploy-spike, error-storm, quiet)
      this.activateMode(this.currentMode)
    }
  }

  /** Stop mode transitions */
  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Get the current active mode */
  getMode(): Mode {
    return this.currentMode
  }

  /** Force a mode change (used by chaos scheduler or external control) */
  setMode(newMode: Mode): void {
    const previous = this.currentMode
    if (previous === newMode) return

    // Deactivate previous mode effects
    this.deactivateMode(previous)

    this.currentMode = newMode

    // Activate new mode effects
    this.activateMode(newMode)

    const event: ModeChangeEvent = { mode: newMode, previousMode: previous }
    this.emit('modeChange', event)
  }

  private activateMode(mode: Mode): void {
    switch (mode) {
      case 'deploy-spike':
        for (const engine of this.engines) engine.activateSpike()
        break
      case 'error-storm':
        for (const engine of this.engines) engine.activateErrorStorm()
        break
      case 'quiet':
        this.scheduler.setRate(this.baseRate * 0.1)
        break
      case 'steady':
        this.scheduler.setRate(this.baseRate)
        break
    }
  }

  private deactivateMode(mode: Mode): void {
    switch (mode) {
      case 'deploy-spike':
        for (const engine of this.engines) engine.deactivateSpike()
        break
      case 'error-storm':
        for (const engine of this.engines) engine.deactivateErrorStorm()
        break
      case 'quiet':
        this.scheduler.setRate(this.baseRate)
        break
    }
  }

  private scheduleChaosTransition(): void {
    if (!this.running) return

    // Steady period: random between min and max
    const steadyMs = randomBetween(
      this.timings.chaos_steady_min_seconds * 1000,
      this.timings.chaos_steady_max_seconds * 1000,
    )

    // Transition to steady first
    this.setMode('steady')

    this.timer = setTimeout(() => {
      if (!this.running) return

      // Pick a random event mode
      const eventModes: Mode[] = ['deploy-spike', 'error-storm', 'quiet']
      const picked = eventModes[Math.floor(Math.random() * eventModes.length)] as Mode

      this.setMode(picked)

      // Schedule duration for the event mode
      const durationMs = this.getEventDuration(picked)

      this.timer = setTimeout(() => {
        if (!this.running) return
        // After event completes, schedule next chaos cycle
        this.scheduleChaosTransition()
      }, durationMs)
    }, steadyMs)
  }

  private getEventDuration(mode: Mode): number {
    switch (mode) {
      case 'deploy-spike':
        return this.timings.spike_duration_seconds * 1000
      case 'error-storm':
        return this.timings.storm_duration_seconds * 1000
      case 'quiet':
        return this.timings.quiet_duration_seconds * 1000
      default:
        return this.timings.spike_duration_seconds * 1000
    }
  }
}

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min
}
