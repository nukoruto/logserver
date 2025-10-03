const morgan = require('morgan');
const logger = require('../utils/logger');

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
