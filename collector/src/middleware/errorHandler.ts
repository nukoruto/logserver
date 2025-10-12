import type { ErrorRequestHandler } from 'express';
import errorHandler from './errorHandler.js';

const legacyErrorHandler: unknown = errorHandler;
const typedErrorHandler = legacyErrorHandler as ErrorRequestHandler;

export default typedErrorHandler;
