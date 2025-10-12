export class AppError extends Error {
  public readonly statusCode: number;

  public readonly details: unknown;

  constructor(message: string, statusCode = 500, details: unknown = undefined) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = details;
    const errorCtor = Error as ErrorConstructor & {
      captureStackTrace?: (target: Error, constructorOpt?: new (...args: unknown[]) => unknown) => void;
    };
    if (typeof errorCtor.captureStackTrace === 'function') {
      errorCtor.captureStackTrace(this, new.target);
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not Found') {
    super(message, 404);
  }
}
