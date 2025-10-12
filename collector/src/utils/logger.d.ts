import type { Logger } from 'winston';

declare const logger: Logger & {
  stream: {
    write(message: string): void;
  };
};

export = logger;
