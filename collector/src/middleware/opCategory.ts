const OPERATION_CATEGORIES = ['AUTH', 'READ', 'UPDATE'] as const;

type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

type RequestLike = Record<string, unknown>;

const OP_CATEGORY_FLAG = '__opCategorySet__' as const;

type Logframe = Record<string, unknown> & {
  op_category?: OperationCategory | string;
  [OP_CATEGORY_FLAG]?: boolean;
};

type Locals = Record<string, unknown> & {
  __logframe?: Logframe;
};

type ResponseLike = {
  locals?: Locals;
};

type NextLike = (err?: unknown) => void;

type Middleware = (req: RequestLike, res: ResponseLike, next: NextLike) => void;

const ensureLocals = (res: ResponseLike): Locals => {
  if (!res.locals || typeof res.locals !== 'object') {
    res.locals = {};
  }
  return res.locals;
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

const opCategory = (category: OperationCategory): Middleware => {
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
