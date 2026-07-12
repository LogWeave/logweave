import { AsyncLocalStorage } from 'node:async_hooks'
import pino from 'pino'

export interface RequestContext {
  requestId: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    mixin() {
      const store = requestContext.getStore()
      return store ? { requestId: store.requestId } : {}
    },
  })
}
