const { CsvSink } = require('./sink/csvSink');
const config = require('./config');
const logger = require('./utils/logger');
const {
  LogRecordValidationError,
  validateLogRecord,
  DEFAULT_OPERATION_CATEGORY,
} = require('./schema/logRecord');
const { OP_CATEGORY_FLAG } = require('./middleware/opCategory');

const toRotation = (input) => {
  if (typeof input === 'string' && input.toLowerCase() === 'hourly') {
    return 'hourly';
  }
  return 'daily';
};

const sanitizeString = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const sanitizeTimestamp = (value) => {
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
};

const sanitizeMethod = (value) => {
  const normalized = sanitizeString(value).toUpperCase();
  return normalized || 'GET';
};

const sanitizeCategory = (value) => {
  const normalized = sanitizeString(value).toUpperCase();
  return normalized || DEFAULT_OPERATION_CATEGORY;
};

const sanitizeInteger = (value) => {
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

const sanitizeFloat = (value) => {
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

const sanitizeLogframe = (input) => {
  const sanitized = {
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

  const statusCode = sanitizeInteger(input.status_code);
  if (statusCode !== undefined) {
    sanitized.status_code = statusCode;
  }

  const latency = sanitizeFloat(input.latency_ms);
  if (latency !== undefined) {
    sanitized.latency_ms = latency;
  }

  return sanitized;
};

const missingCategoryWarnings = new Set();

const warnMissingOperationCategory = (record, categoryApplied) => {
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

const csvSink = new CsvSink({
  dir: config.csvRoot,
  rotation: toRotation(config.csvRotation ?? process.env.CSV_ROTATION),
});

const sigtermHandler = async () => {
  try {
    await csvSink.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to gracefully shutdown CSV sink', { error: message });
  }
};

process.once('SIGTERM', sigtermHandler);

const csvSinkMiddleware = (_req, res, next) => {
  const start = process.hrtime.bigint();
  let flushed = false;

  const flush = () => {
    if (flushed) {
      return;
    }
    flushed = true;

    const locals = res.locals || {};
    const base = locals.__logframe;
    if (!base || typeof base !== 'object') {
      return;
    }

    const elapsedNs = process.hrtime.bigint() - start;
    const elapsedMs = Number(elapsedNs) / 1_000_000;

    const sanitized = sanitizeLogframe(base);
    const record = { ...sanitized };

    const statusFromResponse = Number.isFinite(res.statusCode) ? Math.trunc(res.statusCode) : undefined;
    if (statusFromResponse !== undefined) {
      record.status_code = statusFromResponse;
    }

    if (Number.isFinite(elapsedMs)) {
      record.latency_ms = Number(elapsedMs.toFixed(3));
    }

    const categoryApplied = Boolean(base && base[OP_CATEGORY_FLAG]);
    warnMissingOperationCategory(record, categoryApplied);

    try {
      const validated = validateLogRecord(record);
      csvSink.write(validated).catch((error) => {
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

const shutdownCsvSink = async () => {
  await csvSink.shutdown();
};

module.exports = {
  csvSink,
  csvSinkMiddleware,
  shutdownCsvSink,
  default: csvSink,
};
