import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * Lightweight mock clusterer that returns fixed template responses in <1ms.
 * Matches the ClustererResponse shape from services/api/src/pipeline/cluster-client.ts.
 * Used by Tier 1 benchmarks to isolate API server performance from Python/Drain3.
 */

const HEALTH_RESPONSE = JSON.stringify({ status: 'ok' })

function handleCluster(req: IncomingMessage, res: ServerResponse): void {
  let body = ''
  req.on('data', (chunk: string) => {
    body += chunk
  })
  req.on('end', () => {
    let messageCount = 1
    try {
      const parsed = JSON.parse(body) as { messages?: unknown[] }
      messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 1
    } catch {
      // Fall through with default count
    }

    const results = Array.from({ length: messageCount }, (_, i) => ({
      template_id: `bench-template-${(i % 10).toString()}`,
      template_text: `Benchmark template pattern <*> number ${(i % 10).toString()}`,
      is_new: false,
    }))

    const response = JSON.stringify({ results })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(response)
  })
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(HEALTH_RESPONSE)
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'POST' && req.url === '/cluster') {
    handleCluster(req, res)
  } else if (req.method === 'GET' && req.url === '/health') {
    handleHealth(req, res)
  } else {
    res.writeHead(404)
    res.end()
  }
}

let server: Server | null = null

export function startMockClusterer(port = 8001): Promise<void> {
  return new Promise((resolve, reject) => {
    server = createServer(handleRequest)
    server.on('error', reject)
    server.listen(port, () => {
      resolve()
    })
  })
}

export function stopMockClusterer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    server.close(() => {
      server = null
      resolve()
    })
  })
}
