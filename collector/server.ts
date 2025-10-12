import 'ts-node/register/transpile-only';

import { start } from './src/app';
import logger from './src/utils/logger';

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error('Failed to start server', { error: message, stack });
  process.exitCode = 1;
});
