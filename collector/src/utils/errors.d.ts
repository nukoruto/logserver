export class AppError extends Error {
  constructor(message: string, statusCode?: number, details?: unknown);
  statusCode: number;
  details?: unknown;
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown);
}

export class AuthenticationError extends AppError {
  constructor(message?: string);
}

export class NotFoundError extends AppError {
  constructor(message?: string);
}
