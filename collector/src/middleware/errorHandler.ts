import type { NextFunction, Request, Response } from 'express';
import logger from '../utils/logger';

type AppErrorLike = Error & {
  statusCode: number;
  details?: unknown;
};

const isAppError = (value: unknown): value is AppErrorLike => {
  if (value instanceof Error && typeof (value as { statusCode?: unknown }).statusCode === 'number') {
    return true;
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { statusCode?: unknown };
  return typeof candidate.statusCode === 'number';
};

const toError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : 'Unknown error');
};

const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (isAppError(err)) {
    const appError = err as AppErrorLike;
    if (appError.statusCode >= 500) {
      logger.error(appError.message, { stack: appError.stack, details: appError.details });
    } else {
      logger.warn(appError.message, { details: appError.details });
    }

    res.status(appError.statusCode).json({
      error: appError.message,
      details: appError.details,
    });
    return;
  }

  const unexpected = toError(err);
  logger.error('Unexpected error', { error: unexpected.message, stack: unexpected.stack });
  res.status(500).json({
    error: 'Internal Server Error',
  });
};

export type ErrorHandler = typeof errorHandler;

export { errorHandler };
export default errorHandler;
