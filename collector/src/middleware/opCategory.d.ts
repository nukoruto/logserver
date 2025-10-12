import type { NextFunction, Request, Response } from 'express';

type OperationCategory = 'AUTH' | 'READ' | 'UPDATE';

type OpCategoryMiddleware = (req: Request, res: Response, next: NextFunction) => void;

declare function opCategory(category: OperationCategory): OpCategoryMiddleware;

declare const OPERATION_CATEGORIES: readonly OperationCategory[];
declare const OP_CATEGORY_FLAG: '__opCategorySet__';

declare namespace opCategory {
  export { opCategory };
}

export { opCategory, OPERATION_CATEGORIES, OP_CATEGORY_FLAG, OperationCategory, OpCategoryMiddleware };
export default opCategory;
