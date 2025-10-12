import type { TransformableInfo } from 'logform';
import { createLogger, format, transports } from 'winston';
import config from '../config';

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
    format.printf((info: TransformableInfo & { timestamp?: string; stack?: string }) => {
      const { timestamp, level, message, stack, ...meta } = info;
      const ts = typeof timestamp === 'string' ? timestamp : new Date().toISOString();
      const base = `${ts} [${String(level)}] ${String(message)}`;
      if (typeof stack === 'string' && stack) {
        return `${base}\n${stack}`;
      }
      const metaRecord = meta as Record<string, unknown>;
      const metaKeys = Object.keys(metaRecord);
      if (metaKeys.length > 0) {
        return `${base} ${JSON.stringify(metaRecord)}`;
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

export default logger;
