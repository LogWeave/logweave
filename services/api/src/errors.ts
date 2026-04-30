import { HttpStatus, type HttpStatusCode } from './http-status.js'

export class AppError extends Error {
  constructor(
    public readonly statusCode: HttpStatusCode,
    public readonly code: string,
    message: string,
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

export function payloadTooLarge(message: string): AppError {
  return new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', message)
}

export function internalError(message: string): AppError {
  return new AppError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', message)
}

export function serviceUnavailable(message: string): AppError {
  return new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', message)
}

export function rateLimited(message: string): AppError {
  return new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', message)
}

export interface ErrorResponseBody {
  error: {
    code: string
    message: string
  }
}
