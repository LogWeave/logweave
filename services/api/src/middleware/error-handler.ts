import type { NextFunction, Request, Response } from 'express'
import type pino from 'pino'
import { AppError, type ErrorResponseBody } from '../errors.js'

export function createErrorHandler(logger: pino.Logger) {
  return (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      logger.warn({ err, statusCode: err.statusCode, code: err.code }, err.message)
      const body: ErrorResponseBody = {
        error: { code: err.code, message: err.message },
      }
      res.status(err.statusCode).json(body)
      return
    }

    logger.error({ err }, 'Unhandled error')
    const body: ErrorResponseBody = {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    }
    res.status(500).json(body)
  }
}
