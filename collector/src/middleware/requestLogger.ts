// @ts-expect-error -- morgan lacks bundled type declarations here
import morgan, { type StreamOptions } from 'morgan';
import logger from '../utils/logger';

const stream: StreamOptions = {
  write: (message: string): void => {
    logger.http(message.trim());
  },
};

const requestLogger = morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream,
});

export type RequestLogger = typeof requestLogger;

export { requestLogger };
export default requestLogger;
