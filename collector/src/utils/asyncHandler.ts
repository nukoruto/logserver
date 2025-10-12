import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

const asyncHandler = (fn: AsyncRequestHandler): RequestHandler => {
  const wrapped: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
  return wrapped;
};

export default asyncHandler;
