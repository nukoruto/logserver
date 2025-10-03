const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(err.message, { stack: err.stack, details: err.details });
    } else {
      logger.warn(err.message, { details: err.details });
    }
    return res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
    });
  }

  logger.error('Unexpected error', { error: err, stack: err.stack });
  return res.status(500).json({
    error: 'Internal Server Error',
  });
};

module.exports = errorHandler;
