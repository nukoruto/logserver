import type { RequestHandler, Response } from 'express';

const OPERATION_CATEGORIES = ['AUTH', 'READ', 'UPDATE'] as const;

type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

const OP_CATEGORY_FLAG = '__opCategorySet__' as const;

type Logframe = Record<string, unknown> & {
  op_category?: OperationCategory | string;
  [OP_CATEGORY_FLAG]?: boolean;
};

type Locals = Record<string, unknown> & {
  __logframe?: Logframe;
};

const ensureLocals = (res: Response): Locals => {
  const locals = (res.locals ??= {} as Response['locals']);
  if (typeof locals !== 'object' || locals === null) {
    res.locals = {} as Response['locals'];
  }
  return res.locals as Locals;
};

const ensureLogframe = (locals: Locals): Logframe => {
  if (!locals.__logframe || typeof locals.__logframe !== 'object') {
    locals.__logframe = {};
  }
  return locals.__logframe;
};

const isValidCategory = (category: string): category is OperationCategory => {
  return (OPERATION_CATEGORIES as readonly string[]).includes(category);
};

const opCategory = (category: OperationCategory): RequestHandler => {
  if (!isValidCategory(category)) {
    throw new Error(`Invalid operation category: ${category}`);
  }

  return (_req, res, next) => {
    const locals = ensureLocals(res);
    const logframe = ensureLogframe(locals);

    logframe.op_category = category;
    logframe[OP_CATEGORY_FLAG] = true;

    next();
  };
};

export type { OperationCategory };
export { OP_CATEGORY_FLAG, opCategory };
export default opCategory;
