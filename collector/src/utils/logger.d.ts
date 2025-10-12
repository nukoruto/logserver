import type { LeveledLogMethod, Logger } from 'winston';

export type LoggerStream = {
  write(message: string): void;
};

export interface LoggerWithStream extends Logger {
  http: LeveledLogMethod;
  stream: LoggerStream;
}

declare const logger: LoggerWithStream;

declare const loggerStream: LoggerStream;

export { loggerStream };
export default logger;
