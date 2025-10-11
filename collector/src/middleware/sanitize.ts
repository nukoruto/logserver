import type { Request, Response, NextFunction } from 'express';

export type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const sanitize: Middleware = (_req, res, next) => {
  if (res.locals && typeof res.locals === 'object' && '__logframe' in res.locals) {
    delete res.locals.__logframe;
  }
  next();
};

export { sanitize };
export default sanitize;
