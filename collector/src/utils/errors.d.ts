export class AppError extends Error {
  statusCode: number;
  details?: unknown;
  constructor(message: string, statusCode?: number, details?: unknown);
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

declare const errors: {
  AppError: typeof AppError;
  ValidationError: typeof ValidationError;
  AuthenticationError: typeof AuthenticationError;
  NotFoundError: typeof NotFoundError;
};

export { errors };
export default errors;
