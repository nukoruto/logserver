const { CsvSink } = require('./sink/csvSink');
const config = require('./config');
const logger = require('./utils/logger');

const toRotation = (input) => {
  if (typeof input === 'string' && input.toLowerCase() === 'hourly') {
    return 'hourly';
  }
  return 'daily';
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

    const timestampValue = typeof base.timestamp_utc === 'string' && base.timestamp_utc
      ? base.timestamp_utc
      : new Date().toISOString();

    const elapsedNs = process.hrtime.bigint() - start;
    const elapsedMs = Number(elapsedNs) / 1_000_000;

    const record = {
      ...base,
      timestamp_utc: timestampValue,
      status_code: res.statusCode,
    };

    if (Number.isFinite(elapsedMs)) {
      record.latency_ms = Number(elapsedMs.toFixed(3));
    }

    csvSink.write(record).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to write CSV logframe', { error: message });
    });
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
