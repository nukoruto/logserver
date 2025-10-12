const { mkdir, open } = require('fs/promises');
const path = require('path');
const loggerModule = require('../utils/logger');
const logger = loggerModule.default || loggerModule;
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

const DEFAULT_MAX_IN_MEMORY_QUEUE = 2048;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

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
    this.headers = options.headers ?? DEFAULT_HEADERS;
    this.maxInMemoryQueue = options.maxInMemoryQueue ?? DEFAULT_MAX_IN_MEMORY_QUEUE;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryQueue = [];
    this.retryTimer = null;
    this.activeKey = null;
    this.handle = null;
    this.queue = Promise.resolve();
    this.shuttingDown = false;
    this.pendingWrites = 0;
    this.totalWritten = 0;
    this.lastError = null;
    this.lastSuccessAt = null;
    this.dropTotal = 0;
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

    const pending = {
      key,
      timestampUtc: entry.timestamp_utc,
      serialized,
      attempt: 0,
      nextAttemptAt: Date.now(),
    };

    return this.enqueue(pending);
  }

  async shutdown() {
    if (this.shuttingDown) {
      await this.queue;
      return;
    }
    this.shuttingDown = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryQueue.length > 0) {
      const dropped = this.retryQueue.splice(0, this.retryQueue.length);
      this.recordDrop('shutdown', dropped);
    }
    await this.queue;
    await this.closeHandle();
  }

  enqueue(entry) {
    this.pendingWrites += 1;

    const operation = this.queue
      .then(async () => {
        await this.tryWrite(entry);
      })
      .finally(() => {
        this.pendingWrites = Math.max(0, this.pendingWrites - 1);
      });

    this.queue = operation.catch(() => undefined);

    return operation;
  }

  async tryWrite(entry) {
    try {
      await this.rotateIfNeeded(entry.key, entry.timestampUtc);
      await this.append(entry.serialized);
      this.totalWritten += 1;
      this.lastSuccessAt = new Date();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      entry.attempt += 1;
      this.scheduleRetry(entry);
      throw error;
    }
  }

  scheduleRetry(entry) {
    if (this.shuttingDown) {
      this.recordDrop('shutdown', entry);
      return;
    }
    if (this.retryQueue.length >= this.maxInMemoryQueue) {
      this.recordDrop('queue_overflow', entry);
      return;
    }

    const baseDelay = this.retryBaseDelayMs;
    const computedDelay = baseDelay * Math.pow(2, Math.max(0, entry.attempt - 1));
    const delay = Math.min(this.retryMaxDelayMs, computedDelay);
    entry.nextAttemptAt = Date.now() + delay;

    this.retryQueue.push(entry);
    this.retryQueue.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    this.scheduleRetryTimer();
  }

  scheduleRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const next = this.retryQueue[0];
    if (!next) {
      return;
    }
    const waitMs = Math.max(0, next.nextAttemptAt - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushRetryQueue();
    }, waitMs);
  }

  async flushRetryQueue() {
    if (this.shuttingDown) {
      return;
    }
    const now = Date.now();
    const ready = [];
    while (this.retryQueue.length > 0 && this.retryQueue[0].nextAttemptAt <= now) {
      const entry = this.retryQueue.shift();
      if (entry) {
        ready.push(entry);
      }
    }

    for (const entry of ready) {
      this.pendingWrites += 1;
      const operation = this.queue
        .then(async () => {
          await this.tryWrite(entry);
        })
        .finally(() => {
          this.pendingWrites = Math.max(0, this.pendingWrites - 1);
        });
      this.queue = operation.catch(() => undefined);
    }

    if (this.retryQueue.length > 0) {
      this.scheduleRetryTimer();
    }
  }

  recordDrop(reason, entries) {
    const bucket = Array.isArray(entries) ? entries : [entries];
    if (bucket.length === 0) {
      return;
    }
    this.dropTotal += bucket.length;
    const maxAttempt = bucket.reduce((acc, entry) => Math.max(acc, entry.attempt), 0);
    logger.error('DROP csv logframe from retry queue', {
      reason,
      dropped: bucket.length,
      queueLength: this.retryQueue.length,
      maxQueue: this.maxInMemoryQueue,
      maxAttempt,
    });
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
      queueDepth: this.pendingWrites + this.retryQueue.length,
      dropTotal: this.dropTotal,
      retryQueueDepth: this.retryQueue.length,
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
      pendingWrites: this.pendingWrites + this.retryQueue.length,
      totalWritten: this.totalWritten,
      dropTotal: this.dropTotal,
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
