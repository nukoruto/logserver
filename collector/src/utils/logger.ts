import winston from 'winston';
import config from '../config';

type Transformable = winston.Logform.TransformableInfo & { stack?: string };

export type LoggerStream = {
  write: (message: string) => void;
};

type LoggerWithoutStream = Omit<winston.Logger, 'stream'>;

export type LoggerWithStream = LoggerWithoutStream & {
  http: winston.LeveledLogMethod;
  stream: LoggerStream;
};

const baseLogger = winston.createLogger({
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
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }: Transformable) => {
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
    new winston.transports.Console({
      handleExceptions: true,
    }),
  ],
  exitOnError: false,
});

const logger = baseLogger as unknown as LoggerWithStream;

const stream: LoggerStream = {
  write: (message: string): void => {
    logger.http(message.trim());
  },
};

logger.stream = stream;

export { stream as loggerStream };
export default logger;
