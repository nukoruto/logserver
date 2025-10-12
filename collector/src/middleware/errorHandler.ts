import type { ErrorRequestHandler } from 'express';
import errorHandler from './errorHandler.js';

export default errorHandler as ErrorRequestHandler;
