require('ts-node/register/transpile-only');

const { start } = require('./src/app.ts');
const logger = require('./src/utils/logger');

start().catch((error) => {
  logger.error('Failed to start server', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});
