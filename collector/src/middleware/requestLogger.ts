import type { RequestHandler } from 'express';
import requestLogger from './requestLogger.js';

const legacyRequestLogger: unknown = requestLogger;
const typedRequestLogger = legacyRequestLogger as RequestHandler;

export default typedRequestLogger;
