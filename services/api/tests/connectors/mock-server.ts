import { type AddressInfo, createServer, type IncomingHttpHeaders } from 'node:http'

export interface CapturedRequest {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  body: string
}

export interface MockResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export type MockHandler = (req: CapturedRequest) => MockResponse

export interface MockHttpServer {
  baseUrl: string
  requests: CapturedRequest[]
  last(): CapturedRequest | undefined
  setHandler(fn: MockHandler): void
  close(): Promise<void>
}

/**
 * A throwaway HTTP server bound to 127.0.0.1 for exercising the connector
 * adapters end-to-end through safeFetch. Tests allowlist 127.0.0.1 via
 * LOGWEAVE_CONNECTOR_ALLOWED_HOSTS so the SSRF guard permits the loopback target.
 */
export async function startMockServer(initial: MockHandler): Promise<MockHttpServer> {
  let handler = initial
  const requests: CapturedRequest[] = []

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(captured)
      const { status, body, headers } = handler(captured)
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    last: () => requests[requests.length - 1],
    setHandler: (fn) => {
      handler = fn
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A loopback URL with no listener — connecting to it yields ECONNREFUSED. */
export async function closedBaseUrl(): Promise<string> {
  const tmp = createServer()
  await new Promise<void>((resolve) => tmp.listen(0, '127.0.0.1', resolve))
  const port = (tmp.address() as AddressInfo).port
  await new Promise<void>((resolve) => tmp.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}
