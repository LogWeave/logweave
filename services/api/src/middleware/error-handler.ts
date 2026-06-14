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

    // Express body-parser errors (malformed JSON, etc.) have a statusCode property
    if ('statusCode' in err && typeof (err as Record<string, unknown>).statusCode === 'number') {
      const statusCode = (err as Record<string, unknown>).statusCode as number
      if (statusCode < HttpStatus.INTERNAL_SERVER_ERROR) {
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
