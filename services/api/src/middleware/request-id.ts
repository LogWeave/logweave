import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { requestContext } from '../logger.js'

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('x-request-id')
  const requestId = header && REQUEST_ID_PATTERN.test(header) ? header : crypto.randomUUID()

  res.setHeader('x-request-id', requestId)
  requestContext.run({ requestId }, () => next())
}
