import type { NextFunction, Request, Response } from 'express';

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

declare function asyncHandler<T extends AsyncRouteHandler>(handler: T): (
  req: Request,
  res: Response,
  next: NextFunction
) => void;

export default asyncHandler;
