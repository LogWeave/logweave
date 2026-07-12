import type { NextFunction, Request, Response } from 'express'
import type pino from 'pino'
import { AppError, type ErrorResponseBody } from '../errors.js'
import { HttpStatus } from '../http-status.js'

export function createErrorHandler(logger: pino.Logger) {
  return (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      logger.warn({ err, statusCode: err.statusCode, code: err.code }, err.message)
      if (err.retryAfterSeconds !== undefined) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds))
      }
      const body: ErrorResponseBody = {
        error: { code: err.code, message: err.message },
      }
      res.status(err.statusCode).json(body)
      return
    }

    // Express body-parser errors (malformed JSON, payload too large, etc.) are
    // created via http-errors, which sets `expose = true` on client (4xx) errors
    // to mark their message safe to return. Only echo the message when the error
    // itself opts in this way — a foreign library error that merely happens to
    // carry a numeric statusCode<500 must not leak its (possibly sensitive)
    // message; it falls through to the masked 500 below.
    if ('statusCode' in err && typeof (err as Record<string, unknown>).statusCode === 'number') {
      const errRecord = err as Record<string, unknown>
      const statusCode = errRecord.statusCode as number
      const exposeMessage = errRecord.expose === true
      if (statusCode < HttpStatus.INTERNAL_SERVER_ERROR && exposeMessage) {
        logger.warn({ err, statusCode }, err.message)
        const body: ErrorResponseBody = {
          error: { code: 'BAD_REQUEST', message: err.message },
        }
        res.status(statusCode).json(body)
        return
      }
    }

    logger.error({ err, errMessage: err.message, errStack: err.stack }, 'Unhandled error')
    const body: ErrorResponseBody = {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    }
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body)
  }
}
