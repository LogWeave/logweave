import { HttpStatus, type HttpStatusCode } from './http-status.js'

export class AppError extends Error {
  constructor(
    public readonly statusCode: HttpStatusCode,
    public readonly code: string,
    message: string,
    /** Seconds to advertise via the Retry-After header (503/429 responses). */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function validationError(message: string): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', message)
}

export function unauthorized(message: string): AppError {
  return new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', message)
}

export function forbidden(message: string): AppError {
  return new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message)
}

export function notFound(message: string): AppError {
  return new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', message)
}

export function rateLimited(message: string): AppError {
  return new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', message)
}

export function serviceUnavailable(message: string, retryAfterSeconds?: number): AppError {
  return new AppError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'SERVICE_UNAVAILABLE',
    message,
    retryAfterSeconds,
  )
}

export interface ErrorResponseBody {
  error: {
    code: string
    message: string
  }
}
