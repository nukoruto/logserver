import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtPayload, type VerifyOptions } from 'jsonwebtoken';
import config from '../config';
import { AuthenticationError, AppError } from '../utils/errors';

type AuthenticatedRequest = Request & { user?: JwtPayload };

const authMiddleware = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  if (!config.auth.required) {
    next();
    return;
  }

  if (!config.jwtSecret) {
    next(new AppError('Authentication is required but JWT secret is not configured', 500));
    return;
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    next(new AuthenticationError('Missing bearer token'));
    return;
  }

  try {
    const verifyOptions: VerifyOptions = {};
    if (config.auth.audience) {
      verifyOptions.audience = config.auth.audience;
    }
    if (config.auth.issuer) {
      verifyOptions.issuer = config.auth.issuer;
    }

    const payload = jwt.verify(token, config.jwtSecret, verifyOptions) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    next(new AuthenticationError('Invalid token'));
  }
};

export type AuthMiddleware = typeof authMiddleware;

export { authMiddleware };
export default authMiddleware;
