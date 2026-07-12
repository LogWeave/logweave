/** Code snippets for onboarding Step 1. Placeholders replaced at render time. */

/** Shown in the Authorization header when the dashboard has no API key configured. */
export const API_KEY_PLACEHOLDER = 'YOUR_API_KEY'
const DEFAULT_API_URL = 'http://localhost:3000'

export function curlSnippet(apiUrl: string, apiKey: string): string {
  const endpoint = apiUrl || DEFAULT_API_URL
  const key = apiKey || API_KEY_PLACEHOLDER
  return `curl -X POST ${endpoint}/v1/ingest/batch \\
  -H "Authorization: Bearer ${key}" \\
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
  const endpoint = apiUrl || DEFAULT_API_URL
  const key = apiKey || API_KEY_PLACEHOLDER
  return `import { LogWeaveTransport } from "@logweave/transport";
import winston from "winston";

const logger = winston.createLogger({
  transports: [
    new LogWeaveTransport({
      endpoint: "${endpoint}",
      apiKey: "${key}",
      service: "my-service",
    }),
  ],
});

logger.info("User login succeeded");`
}

export function pythonSnippet(apiUrl: string, apiKey: string): string {
  const endpoint = apiUrl || DEFAULT_API_URL
  const key = apiKey || API_KEY_PLACEHOLDER
  return `import requests

requests.post(
    "${endpoint}/v1/ingest/batch",
    headers={"Authorization": "Bearer ${key}"},
    json={"events": [{
        "message": "User login succeeded",
        "level": "INFO",
        "service": "auth-service",
    }]},
)`
}

export function goSnippet(apiUrl: string, apiKey: string): string {
  const endpoint = apiUrl || DEFAULT_API_URL
  const key = apiKey || API_KEY_PLACEHOLDER
  return `package main

import (
  "bytes"
  "net/http"
)

func main() {
  body := []byte(\`{"events":[{"message":"User login succeeded","level":"INFO","service":"auth-service"}]}\`)
  req, _ := http.NewRequest("POST", "${endpoint}/v1/ingest/batch", bytes.NewBuffer(body))
  req.Header.Set("Authorization", "Bearer ${key}")
  req.Header.Set("Content-Type", "application/json")
  http.DefaultClient.Do(req)
}`
}

export function otelSnippet(apiUrl: string, apiKey: string): string {
  const endpoint = apiUrl || DEFAULT_API_URL
  const key = apiKey || API_KEY_PLACEHOLDER
  return `# otel-collector-config.yaml
exporters:
  otlphttp:
    endpoint: "${endpoint}/v1/logs"
    headers:
      authorization: "Bearer ${key}"

service:
  pipelines:
    logs:
      exporters: [otlphttp]`
}

export function mcpSnippet(apiUrl: string, apiKey: string): string {
  const endpoint = apiUrl || DEFAULT_API_URL
  const key = apiKey || API_KEY_PLACEHOLDER
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
