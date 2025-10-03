const { start } = require('./src/server/app');
const logger = require('./src/server/utils/logger');

start().catch((error) => {
  logger.error('Failed to start server', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});
