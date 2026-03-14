export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function validationError(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message)
}

export function unauthorized(message: string): AppError {
  return new AppError(401, 'UNAUTHORIZED', message)
}

export function notFound(message: string): AppError {
  return new AppError(404, 'NOT_FOUND', message)
}

export function payloadTooLarge(message: string): AppError {
  return new AppError(413, 'PAYLOAD_TOO_LARGE', message)
}

export function internalError(message: string): AppError {
  return new AppError(500, 'INTERNAL_ERROR', message)
}

export function serviceUnavailable(message: string): AppError {
  return new AppError(503, 'SERVICE_UNAVAILABLE', message)
}

export interface ErrorResponseBody {
  error: {
    code: string
    message: string
  }
}
