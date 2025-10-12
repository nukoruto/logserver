import logger from './src/utils/logger';
import { start } from './src/app';

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error('Failed to start server', { error: message, stack });
  process.exitCode = 1;
});
