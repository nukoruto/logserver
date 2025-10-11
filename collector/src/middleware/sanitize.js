const sanitize = (_req, res, next) => {
  if (res.locals && typeof res.locals === 'object' && '__logframe' in res.locals) {
    delete res.locals.__logframe;
  }
  next();
};

module.exports = sanitize;
module.exports.sanitize = sanitize;
