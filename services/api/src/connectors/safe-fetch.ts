/**
 * SSRF-safe HTTP client for outbound connector requests (Elasticsearch, Loki).
 *
 * A connector URL is attacker-influenced (a tenant admin supplies it), so a
 * naive `fetch` lets them reach internal services or cloud metadata
 * (169.254.169.254). Validating the hostname string at create-time is not
 * enough — it's defeated by DNS rebinding (the name resolves to a public IP
 * when created, an internal IP when fetched) and by HTTP redirects.
 *
 * Defenses here:
 *   - DNS is resolved through a custom `lookup` that rejects any internal IP at
 *     the moment the socket connects. Because validation happens on the actual
 *     resolved address used for the connection, rebinding cannot slip a
 *     different IP past the check (no resolve-then-connect TOCTOU window).
 *   - Redirects are followed manually, re-validating every hop. node's http
 *     client does not auto-follow, so a 3xx to an internal target is caught.
 *   - Enforced unconditionally. Internal targets are blocked by default; an
 *     explicit host allowlist (LOGWEAVE_CONNECTOR_ALLOWED_HOSTS) is the only
 *     opt-in, so the control can never be silently disabled by NODE_ENV.
 *
 * Uses only node built-ins (node:http/https/dns/net) — no new dependencies.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024 // 16 MiB — guards against a hostile/huge body

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

// ---------------------------------------------------------------------------
// IP / host classification
// ---------------------------------------------------------------------------

function isInternalIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true // unparseable — fail closed
  }
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false
}

/**
 * Expand any valid IPv6 text form to its eight 16-bit hextets. Handles `::`
 * compression and a trailing dotted-decimal IPv4 (`::ffff:127.0.0.1`). Returns
 * null if the string can't be expanded to exactly eight hextets.
 */
function expandIpv6(input: string): number[] | null {
  let s = input
  // Fold a trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) into two hextets so the
  // dotted and hex-colon (::ffff:7f00:1) notations classify identically.
  const dotted = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/)
  if (dotted?.[1] && dotted[2]) {
    const v4 = dotted[2].split('.').map(Number)
    if (v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const [a, b, c, d] = v4 as [number, number, number, number]
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let parts: string[]
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    parts = [...head, ...new Array(missing).fill('0'), ...tail]
  } else {
    parts = head
  }
  if (parts.length !== 8) return null
  const nums = parts.map((p) => Number.parseInt(p || '0', 16))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null
  return nums
}

function isInternalIpv6(ip: string): boolean {
  const hextets = expandIpv6(ip)
  if (!hextets) return true // unparseable — fail closed
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d) —
  // judge by the embedded IPv4 so 127.x / metadata / RFC1918 can't hide here.
  const firstFiveZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0
  if (firstFiveZero && h5 === 0xffff) {
    return isInternalIpv4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`)
  }
  if (firstFiveZero && h5 === 0 && (h6 !== 0 || h7 > 1)) {
    return isInternalIpv4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`)
  }
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0) {
    return true // :: unspecified and ::1 loopback
  }
  if ((h0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if ((h0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((h0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  return false
}

/**
 * True if an already-resolved IP address falls in a loopback, link-local,
 * private, or otherwise non-public range. Conservative: anything it can't
 * parse is treated as internal (fail closed).
 */
export function isInternalIp(ip: string): boolean {
  let v = ip.trim()
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1)
  const pct = v.indexOf('%') // strip zone id (fe80::1%eth0)
  if (pct !== -1) v = v.slice(0, pct)
  v = v.toLowerCase()
  const kind = isIP(v)
  if (kind === 4) return isInternalIpv4(v)
  if (kind === 6) return isInternalIpv6(v)
  return true // not a valid IP literal — fail closed
}

/**
 * Fast pre-connection check on the hostname string. Catches obvious internal
 * targets (localhost, raw internal IP literals) before we even resolve DNS.
 * The authoritative guard is the resolve-time IP check in {@link guardedLookup}.
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (isIP(h)) return isInternalIp(h)
  return false
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Hosts explicitly trusted to resolve to internal addresses (dev/self-host
 * pointing at a sidecar Loki/Elasticsearch). Comma-separated, case-insensitive.
 * Empty by default — internal targets are blocked.
 */
export function defaultAllowedHosts(): Set<string> {
  const raw = process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS ?? ''
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

// ---------------------------------------------------------------------------
// Guarded DNS lookup
// ---------------------------------------------------------------------------

export type LookupFn = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void

/**
 * The resolve-time SSRF decision: throw if any address a hostname resolved to is
 * internal, unless the host is explicitly allowlisted. This is the core guard —
 * it runs for every connection (including each redirect hop) on the actual IPs
 * the socket will use, so DNS rebinding cannot substitute a different address.
 */
export function assertAddressesAllowed(
  hostname: string,
  addresses: readonly { address: string }[],
  allowedHosts: Set<string>,
): void {
  if (allowedHosts.has(hostname.toLowerCase())) return
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`No addresses resolved for ${hostname}`)
  }
  const blocked = addresses.find((a) => isInternalIp(a.address))
  if (blocked) {
    throw new SsrfBlockedError(
      `Refusing to connect to ${hostname}: resolves to internal address ${blocked.address}`,
    )
  }
}

/**
 * A node lookup() implementation that rejects internal addresses. Note node only
 * invokes lookup for DNS names — IP-literal hosts connect directly and are
 * guarded by the synchronous {@link isBlockedHostname} pre-check in safeFetch.
 */
export function makeGuardedLookup(allowedHosts: Set<string>): LookupFn {
  return (hostname, options, callback) => {
    // Resolve every address so we can reject if any one of them is internal,
    // then answer in the shape node asked for.
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, [])
        return
      }
      try {
        assertAddressesAllowed(hostname, addresses, allowedHosts)
      } catch (guardErr) {
        callback(guardErr as NodeJS.ErrnoException, [])
        return
      }
      if (options.all) {
        callback(null, addresses)
      } else {
        // assertAddressesAllowed guarantees a non-empty list here.
        const [first] = addresses as [LookupAddress, ...LookupAddress[]]
        callback(null, first.address, first.family)
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Minimal fetch-Response-compatible surface used by the connector adapters. */
export interface SafeResponse {
  ok: boolean
  status: number
  statusText: string
  text(): Promise<string>
  json(): Promise<unknown>
}

export interface SafeFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** Trusted internal hosts; defaults to LOGWEAVE_CONNECTOR_ALLOWED_HOSTS. */
  allowedHosts?: Set<string>
}

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------

export async function safeFetch(
  target: string | URL,
  init: SafeFetchInit = {},
): Promise<SafeResponse> {
  const allowedHosts = init.allowedHosts ?? defaultAllowedHosts()
  const lookup = makeGuardedLookup(allowedHosts)

  let current = typeof target === 'string' ? new URL(target) : target
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body

  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new SsrfBlockedError(`Unsupported protocol: ${current.protocol}`)
    }
    if (!allowedHosts.has(current.hostname.toLowerCase()) && isBlockedHostname(current.hostname)) {
      throw new SsrfBlockedError(`Refusing to connect to internal host ${current.hostname}`)
    }

    const res = await rawRequest(
      current,
      { method, headers: init.headers, body, signal: init.signal },
      lookup,
    )

    const status = res.message.statusCode ?? 0
    const location = res.message.headers.location
    const isRedirect =
      status === 301 || status === 302 || status === 303 || status === 307 || status === 308
    if (isRedirect && location) {
      res.message.resume() // drain and discard the redirect body
      if (redirects >= MAX_REDIRECTS) {
        throw new SsrfBlockedError(`Too many redirects (>${MAX_REDIRECTS})`)
      }
      current = new URL(location, current)
      // 303 (and the common 301/302 behaviour) downgrade to GET without a body.
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      continue
    }

    const text = await readBody(res.message)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: res.message.statusMessage ?? '',
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
    }
  }
}

// ---------------------------------------------------------------------------
// Low-level request
// ---------------------------------------------------------------------------

function rawRequest(
  url: URL,
  opts: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  lookup: LookupFn,
): Promise<{ message: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError(opts.signal))
      return
    }

    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      url,
      {
        method: opts.method,
        headers: opts.headers,
        // Validate the resolved IP at connect time — rebinding-proof.
        lookup: lookup as never,
      },
      (message) => resolve({ message }),
    )

    const onAbort = () => {
      req.destroy(abortError(opts.signal))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    req.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })

    if (opts.body) req.write(opts.body)
    req.end()
  })
}

function readBody(message: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    message.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_RESPONSE_BYTES) {
        message.destroy()
        reject(new Error('Response body too large'))
        return
      }
      chunks.push(chunk)
    })
    message.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    message.on('error', reject)
  })
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}
