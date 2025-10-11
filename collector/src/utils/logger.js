const { createLogger, format, transports } = require('winston');
const config = require('../config');

const logger = createLogger({
  level: config.env === 'production' ? 'info' : 'debug',
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6,
  },
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack, ...meta }) => {
      const base = `${timestamp} [${level}] ${message}`;
      if (stack) {
        return `${base}\n${stack}`;
      }
      const metaKeys = Object.keys(meta);
      if (metaKeys.length > 0) {
        return `${base} ${JSON.stringify(meta)}`;
      }
      return base;
    })
  ),
  transports: [
    new transports.Console({
      handleExceptions: true,
    }),
  ],
  exitOnError: false,
});

logger.stream = {
  write: (message) => {
    logger.http(message.trim());
  },
};

module.exports = logger;
