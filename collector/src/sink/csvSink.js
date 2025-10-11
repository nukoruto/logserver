const { mkdir, open } = require('fs/promises');
const path = require('path');
const {
  LogRecordValidationError,
  validateLogRecord,
} = require('../schema/logRecord');

const RFC4180_NEEDS_QUOTE = /[",\r\n]/;

const DEFAULT_HEADERS = [
  'timestamp_utc',
  'uid',
  'session_id',
  'method',
  'path',
  'referer',
  'user_agent',
  'ip',
  'op_category',
  'status_code',
  'latency_ms',
];

const toTimestamp = (input) => {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return new Date();
  }
  return date;
};

const pad = (value) => value.toString().padStart(2, '0');

const buildKey = (timestampUtc, rotation) => {
  const date = toTimestamp(timestampUtc);
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  if (rotation === 'hourly') {
    const hour = pad(date.getUTCHours());
    const key = `${year}-${month}-${day}-${hour}`;
    return { key, file: `${key}.csv` };
  }
  const key = `${year}-${month}-${day}`;
  return { key, file: `${key}.csv` };
};

class CsvSink {
  constructor(options) {
    this.dir = options.dir;
    this.rotation = options.rotation;
    this.headers = options.headers || DEFAULT_HEADERS;
    this.activeKey = null;
    this.handle = null;
    this.queue = Promise.resolve();
    this.shuttingDown = false;
    this.pendingWrites = 0;
    this.totalWritten = 0;
    this.lastError = null;
    this.lastSuccessAt = null;
  }

  write(record) {
    if (this.shuttingDown) {
      return Promise.reject(new Error('CsvSink is shutting down'));
    }

    let entry;
    try {
      entry = validateLogRecord(record);
    } catch (error) {
      if (error instanceof LogRecordValidationError) {
        return Promise.reject(error);
      }
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const { key } = buildKey(entry.timestamp_utc, this.rotation);
    const serialized = this.serialize(entry);

    this.pendingWrites += 1;

    const operation = this.queue
      .then(async () => {
        try {
          await this.rotateIfNeeded(key, entry.timestamp_utc);
          await this.append(serialized);
          this.totalWritten += 1;
          this.lastSuccessAt = new Date();
          this.lastError = null;
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      })
      .finally(() => {
        this.pendingWrites = Math.max(0, this.pendingWrites - 1);
      });

    this.queue = operation.catch(() => undefined);

    return operation;
  }

  async shutdown() {
    if (this.shuttingDown) {
      await this.queue;
      return;
    }
    this.shuttingDown = true;
    await this.queue;
    await this.closeHandle();
  }

  async rotateIfNeeded(key, timestampUtc) {
    if (this.handle && this.activeKey === key) {
      return;
    }
    await this.closeHandle();

    await mkdir(this.dir, { recursive: true });
    const { file } = buildKey(timestampUtc, this.rotation);
    const fullPath = path.resolve(this.dir, file);
    this.handle = await open(fullPath, 'a');
    this.activeKey = key;

    const stats = await this.handle.stat();
    if (stats.size === 0) {
      const headerLine = `${this.headers.join(',')}`;
      await this.handle.appendFile(`${headerLine}\r\n`, 'utf8');
      await this.handle.datasync();
    }
  }

  async append(serialized) {
    if (!this.handle) {
      throw new Error('File handle is not initialized');
    }
    await this.handle.appendFile(serialized, 'utf8');
    await this.handle.datasync();
  }

  async closeHandle() {
    if (!this.handle) {
      return;
    }
    await this.handle.close();
    this.handle = null;
    this.activeKey = null;
  }

  getMetrics() {
    return {
      totalWritten: this.totalWritten,
      queueDepth: this.pendingWrites,
    };
  }

  getHealthStatus() {
    const shuttingDown = this.shuttingDown;
    const hasError = this.lastError !== null;
    const state = shuttingDown ? 'shutting_down' : hasError ? 'degraded' : 'ok';

    return {
      healthy: !shuttingDown && !hasError,
      state,
      shuttingDown,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      pendingWrites: this.pendingWrites,
      totalWritten: this.totalWritten,
    };
  }

  serialize(record) {
    const values = this.headers.map((key) => {
      const raw = record[key];
      return this.formatCell(raw);
    });
    return `${values.join(',')}\r\n`;
  }

  formatCell(value) {
    if (value === undefined || value === null) {
      return '';
    }
    const stringValue = typeof value === 'string' ? value : String(value);
    if (!RFC4180_NEEDS_QUOTE.test(stringValue)) {
      return stringValue;
    }
    const escaped = stringValue.replace(/"/g, '""');
    return `"${escaped}"`;
  }
}

module.exports = CsvSink;
module.exports.CsvSink = CsvSink;
module.exports.default = CsvSink;
module.exports.__esModule = true;
