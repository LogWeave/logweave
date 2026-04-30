/** Code snippets for onboarding Step 1. Placeholders replaced at render time. */

export function curlSnippet(apiUrl: string, apiKey: string): string {
  return `curl -X POST ${apiUrl}/v1/ingest/batch \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "events": [{
      "message": "User login succeeded",
      "level": "INFO",
      "service": "auth-service"
    }]
  }'`
}

export function nodeSnippet(apiUrl: string, apiKey: string): string {
  return `import { LogWeaveTransport } from "@logweave/transport";
import winston from "winston";

const logger = winston.createLogger({
  transports: [
    new LogWeaveTransport({
      endpoint: "${apiUrl}",
      apiKey: "${apiKey}",
      service: "my-service",
    }),
  ],
});

logger.info("User login succeeded");`
}

export function pythonSnippet(apiUrl: string, apiKey: string): string {
  return `import requests

requests.post(
    "${apiUrl}/v1/ingest/batch",
    headers={"Authorization": "Bearer ${apiKey}"},
    json={"events": [{
        "message": "User login succeeded",
        "level": "INFO",
        "service": "auth-service",
    }]},
)`
}

export function goSnippet(apiUrl: string, apiKey: string): string {
  return `package main

import (
  "bytes"
  "net/http"
)

func main() {
  body := []byte(\`{"events":[{"message":"User login succeeded","level":"INFO","service":"auth-service"}]}\`)
  req, _ := http.NewRequest("POST", "${apiUrl}/v1/ingest/batch", bytes.NewBuffer(body))
  req.Header.Set("Authorization", "Bearer ${apiKey}")
  req.Header.Set("Content-Type", "application/json")
  http.DefaultClient.Do(req)
}`
}

export function otelSnippet(apiUrl: string, apiKey: string): string {
  return `# otel-collector-config.yaml
exporters:
  otlphttp:
    endpoint: "${apiUrl}/v1/logs"
    headers:
      authorization: "Bearer ${apiKey}"

service:
  pipelines:
    logs:
      exporters: [otlphttp]`
}

export function mcpSnippet(apiUrl: string, apiKey: string): string {
  const endpoint = apiUrl || 'http://localhost:3000'
  const key = apiKey || 'YOUR_API_KEY'
  return `{
  "mcpServers": {
    "logweave": {
      "command": "npx",
      "args": ["@logweave/mcp"],
      "env": {
        "LOGWEAVE_API_URL": "${endpoint}",
        "LOGWEAVE_API_KEY": "${key}"
      }
    }
  }
}`
}
