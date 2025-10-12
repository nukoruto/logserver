const { start } = require('./src/app');
const loggerModule = require('./src/utils/logger');
const logger = loggerModule.default || loggerModule;

start().catch((error) => {
  logger.error('Failed to start server', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});
