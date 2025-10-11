import type { Request, Response, NextFunction } from 'express';
import CsvSink, { type CsvRecord, type Rotation } from './sink/csvSink';
import { LogRecordValidationError, validateLogRecord } from './schema/logRecord';
import config from './config';
import logger from './utils/logger';

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
  __logframe?: Record<string, unknown>;
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

    const timestampValue = typeof base.timestamp_utc === 'string' && base.timestamp_utc
      ? base.timestamp_utc
      : new Date().toISOString();

    const elapsedNs = process.hrtime.bigint() - start;
    const elapsedMs = Number(elapsedNs) / 1_000_000;

    const record: CsvRecord = {
      ...(base as Record<string, unknown>),
      timestamp_utc: timestampValue,
      status_code: res.statusCode,
    };

    if (Number.isFinite(elapsedMs)) {
      record.latency_ms = Number(elapsedMs.toFixed(3));
    }

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
