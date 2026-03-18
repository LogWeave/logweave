import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodType, ZodTypeDef } from 'zod'
import { validationError } from '../errors.js'

const PARSED_QUERY_KEY = Symbol('parsedQuery')

/**
 * Create validation middleware for query parameters using a Zod schema.
 * On success, stores the parsed (and potentially coerced) value for retrieval
 * via getQuery(). On failure, passes a validationError to the error handler.
 *
 * Query params arrive as strings from Express — use z.coerce in the schema
 * for numeric/boolean fields.
 *
 * The `Input` type parameter is `unknown` by default so schemas using
 * .transform() or .default() (where input != output) don't cause type errors.
 */
export function validateQuery<T, Input = unknown>(schema: ZodType<T, ZodTypeDef, Input>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      next(validationError(messages.join('; ')))
      return
    }
    ;(req as unknown as Record<symbol, unknown>)[PARSED_QUERY_KEY] = result.data
    next()
  }
}

/**
 * Read the validated query parameters from the request.
 * Throws if validateQuery middleware has not run (programming error).
 */
export function getQuery<T>(req: Request): T {
  const parsed = (req as unknown as Record<symbol, unknown>)[PARSED_QUERY_KEY]
  if (parsed === undefined) {
    throw new Error('getQuery called without validateQuery middleware — programming error')
  }
  return parsed as T
}
