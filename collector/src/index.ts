import type { Request, Response, NextFunction } from 'express';
import CsvSink, { type CsvRecord, type Rotation } from './sink/csvSink';
import { LogRecordValidationError, validateLogRecord, DEFAULT_OPERATION_CATEGORY } from './schema/logRecord';
import config from './config';
import logger from './utils/logger';
import { OP_CATEGORY_FLAG } from './middleware/opCategory';

type LogframeMeta = Record<string, unknown> & {
  [OP_CATEGORY_FLAG]?: boolean;
};

const toRotation = (input: unknown): Rotation => {
  if (typeof input === 'string' && input.toLowerCase() === 'hourly') {
    return 'hourly';
  }
  return 'daily';
};

const csvSink = new CsvSink({
  dir: config.csvRoot,
  rotation: toRotation((config as Record<string, unknown>).csvRotation ?? process.env.CSV_ROTATION),
});

const sigtermHandler = async (): Promise<void> => {
  try {
    await csvSink.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to gracefully shutdown CSV sink', { error: message });
  }
};

process.once('SIGTERM', sigtermHandler);

type LocalsWithLogframe = {
  __logframe?: LogframeMeta;
};

const sanitizeString = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const sanitizeTimestamp = (value: unknown): string => {
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
};

const sanitizeMethod = (value: unknown): CsvRecord['method'] => {
  const normalized = sanitizeString(value).toUpperCase();
  return (normalized || 'GET') as CsvRecord['method'];
};

const sanitizeCategory = (value: unknown): CsvRecord['op_category'] => {
  const normalized = sanitizeString(value).toUpperCase();
  return (normalized || DEFAULT_OPERATION_CATEGORY) as CsvRecord['op_category'];
};

const sanitizeInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const sanitizeFloat = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
};

const sanitizeLogframe = (input: Record<string, unknown>): CsvRecord => {
  const sanitized: Partial<CsvRecord> = {
    timestamp_utc: sanitizeTimestamp(input.timestamp_utc),
    method: sanitizeMethod(input.method),
    path: sanitizeString(input.path),
    referer: sanitizeString(input.referer),
    user_agent: sanitizeString(input.user_agent),
    uid: sanitizeString(input.uid),
    session_id: sanitizeString(input.session_id),
    ip: sanitizeString(input.ip),
    op_category: sanitizeCategory(input.op_category),
  };

  const statusCode = sanitizeInteger((input as Record<string, unknown>).status_code);
  if (statusCode !== undefined) {
    sanitized.status_code = statusCode;
  }

  const latency = sanitizeFloat((input as Record<string, unknown>).latency_ms);
  if (latency !== undefined) {
    sanitized.latency_ms = latency;
  }

  return sanitized as CsvRecord;
};

const missingCategoryWarnings = new Set<string>();

const warnMissingOperationCategory = (record: CsvRecord, categoryApplied: boolean): void => {
  if (categoryApplied) {
    return;
  }
  if (record.op_category !== DEFAULT_OPERATION_CATEGORY) {
    return;
  }
  const key = `${record.method}:${record.path || '/'}`;
  if (missingCategoryWarnings.has(key)) {
    return;
  }
  missingCategoryWarnings.add(key);
  logger.warn('Operation category middleware missing for route', {
    method: record.method,
    path: record.path || '/',
  });
};

const csvSinkMiddleware = (_req: Request, res: Response, next: NextFunction): void => {
  const start = process.hrtime.bigint();
  let flushed = false;

  const flush = (): void => {
    if (flushed) {
      return;
    }
    flushed = true;

    const locals = res.locals as LocalsWithLogframe;
    const base = locals.__logframe;
    if (!base || typeof base !== 'object') {
      return;
    }

    const elapsedNs = process.hrtime.bigint() - start;
    const elapsedMs = Number(elapsedNs) / 1_000_000;

    const sanitized = sanitizeLogframe(base);
    const record: CsvRecord = { ...sanitized };

    const statusFromResponse = Number.isFinite(res.statusCode) ? Math.trunc(res.statusCode) : undefined;
    if (statusFromResponse !== undefined) {
      record.status_code = statusFromResponse;
    }

    if (Number.isFinite(elapsedMs)) {
      record.latency_ms = Number(elapsedMs.toFixed(3));
    }

    const categoryApplied = Boolean((base as LogframeMeta)[OP_CATEGORY_FLAG]);
    warnMissingOperationCategory(record, categoryApplied);

    try {
      const validated = validateLogRecord(record);
      void csvSink.write(validated).catch((error: unknown) => {
        if (error instanceof LogRecordValidationError) {
          logger.error('Rejected CSV logframe due to schema violation', { issues: error.issues });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to write CSV logframe', { error: message });
      });
    } catch (error) {
      if (error instanceof LogRecordValidationError) {
        logger.error('Discarded CSV logframe due to schema violation', { issues: error.issues });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to validate CSV logframe', { error: message });
    }
  };

  res.once('finish', flush);
  res.once('close', flush);

  next();
};

const shutdownCsvSink = async (): Promise<void> => {
  await csvSink.shutdown();
};

export { csvSink, csvSinkMiddleware, shutdownCsvSink };
export default csvSink;
