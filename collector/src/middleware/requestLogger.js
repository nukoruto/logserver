const morgan = require('morgan');
const loggerModule = require('../utils/logger');
const logger = loggerModule.default || loggerModule;

const requestLogger = morgan(
  ':method :url :status :res[content-length] - :response-time ms',
  {
    stream: {
      write: (message) => {
        logger.http(message.trim());
      },
    },
  }
);

module.exports = requestLogger;
