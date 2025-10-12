import type { RequestHandler } from 'express';
import requestLogger from './requestLogger.js';

export default requestLogger as RequestHandler;
