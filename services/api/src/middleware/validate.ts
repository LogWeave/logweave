import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodType } from 'zod'
import { validationError } from '../errors.js'

/**
 * Create validation middleware for request body using a Zod schema.
 * On success, replaces req.body with the parsed (and potentially transformed) value.
 * On failure, passes a validationError to the error handler.
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      next(validationError(messages.join('; ')))
      return
    }
    req.body = result.data
    next()
  }
}
