const OPERATION_CATEGORIES = ['AUTH', 'READ', 'UPDATE'];
const OP_CATEGORY_FLAG = '__opCategorySet__';

const ensureLocals = (res) => {
  if (!res.locals || typeof res.locals !== 'object') {
    res.locals = {};
  }
  return res.locals;
};

const ensureLogframe = (locals) => {
  if (!locals.__logframe || typeof locals.__logframe !== 'object') {
    locals.__logframe = {};
  }
  return locals.__logframe;
};

const isValidCategory = (category) => {
  return OPERATION_CATEGORIES.includes(category);
};

const opCategory = (category) => {
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

module.exports = opCategory;
module.exports.opCategory = opCategory;
module.exports.OP_CATEGORY_FLAG = OP_CATEGORY_FLAG;
module.exports.OperationCategory = undefined;
