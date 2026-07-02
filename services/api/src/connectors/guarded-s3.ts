/**
 * SSRF-safe request handler for the AWS S3 SDK (#286).
 *
 * A tenant-configured S3 connector may set a custom `endpoint` (dev-only, for an
 * S3-compatible emulator). Its hostname is string-validated at connector-create
 * time (routes/connectors.ts), but the AWS SDK does its own DNS and does NOT go
 * through {@link safeFetch}, so a create-time-safe hostname that *resolves* to an
 * internal IP at connect time (DNS rebinding) would otherwise reach the SDK.
 *
 * This wraps `S3Client` with a request handler whose http/https agents resolve
 * DNS through the same rebinding-proof {@link makeGuardedLookup} guard as
 * safeFetch: node's `http(s).Agent` forwards its `lookup` option to the socket
 * connect, so the guard runs on the ACTUAL resolved IP the socket will use — no
 * resolve-then-connect TOCTOU window. Internal IPs are refused unless the host is
 * explicitly allowlisted via LOGWEAVE_CONNECTOR_ALLOWED_HOSTS (the dev opt-in,
 * identical to the Loki/Elasticsearch path).
 */
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import type { LookupFunction } from 'node:net'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { defaultAllowedHosts, makeGuardedLookup } from './safe-fetch.js'

export function guardedS3RequestHandler(
  allowedHosts: Set<string> = defaultAllowedHosts(),
): NodeHttpHandler {
  // makeGuardedLookup returns a node dns.lookup-shaped callback; net.Agent types
  // it as LookupFunction (same runtime contract, narrower option typing).
  const lookup = makeGuardedLookup(allowedHosts) as unknown as LookupFunction
  return new NodeHttpHandler({
    httpAgent: new HttpAgent({ lookup }),
    httpsAgent: new HttpsAgent({ lookup }),
  })
}
