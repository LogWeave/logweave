import type { CliOptions, Mode } from './types.js'

const VALID_MODES: readonly Mode[] = ['steady', 'deploy-spike', 'error-storm', 'quiet', 'chaos']

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  const rateRaw = getArg(argv, '--rate')
  const rate = Number(rateRaw ?? '10')
  if (Number.isNaN(rate) || rate <= 0) {
    throw new Error('--rate must be a positive number')
  }

  const servicesRaw = getArg(argv, '--services') ?? 'all'
  const services = servicesRaw === 'all' ? ['all'] : servicesRaw.split(',').map((s) => s.trim())

  const modeRaw = getArg(argv, '--mode') ?? process.env.LOGWEAVE_SIM_MODE ?? 'steady'
  if (!VALID_MODES.includes(modeRaw as Mode)) {
    throw new Error(`--mode must be one of: ${VALID_MODES.join(', ')}`)
  }
  const mode = modeRaw as Mode

  const duration = Number(getArg(argv, '--duration') ?? '0')
  if (Number.isNaN(duration) || duration < 0) {
    throw new Error('--duration must be a non-negative number')
  }

  const apiKey = getArg(argv, '--api-key') ?? process.env.LOGWEAVE_SIM_API_KEY ?? 'e2e-key-tenant-a'

  const endpoint =
    getArg(argv, '--endpoint') ??
    process.env.LOGWEAVE_SIM_ENDPOINT ??
    'http://localhost:3000/v1/ingest/batch'

  const bufferSizeRaw = getArg(argv, '--buffer-size')
  const bufferSize = Number(bufferSizeRaw ?? '100')
  if (Number.isNaN(bufferSize) || bufferSize <= 0) {
    throw new Error('--buffer-size must be a positive number')
  }

  const flushMsRaw = getArg(argv, '--flush-ms')
  const flushMs = Number(flushMsRaw ?? '2000')
  if (Number.isNaN(flushMs) || flushMs <= 0) {
    throw new Error('--flush-ms must be a positive number')
  }

  const dryRun = hasFlag(argv, '--dry-run')

  return {
    rate,
    services,
    mode,
    duration,
    apiKey,
    endpoint,
    bufferSize,
    flushMs,
    dryRun,
    _explicit: {
      rate: rateRaw !== undefined,
      bufferSize: bufferSizeRaw !== undefined,
      flushMs: flushMsRaw !== undefined,
    },
  }
}
