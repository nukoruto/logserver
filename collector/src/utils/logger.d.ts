import type { LeveledLogMethod, Logger } from 'winston';

export type LoggerStream = {
  write(message: string): void;
};

export type LoggerWithStream = Omit<Logger, 'stream'> & {
  http: LeveledLogMethod;
  stream: LoggerStream;
};

declare const logger: LoggerWithStream;

declare const loggerStream: LoggerStream;

export { loggerStream };
export default logger;
