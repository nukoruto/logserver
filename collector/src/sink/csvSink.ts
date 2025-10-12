import { mkdir, open, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import logger from '../utils/logger';
import {
  type LogRecord,
  LogRecordValidationError,
  validateLogRecord,
} from '../schema/logRecord';

type Rotation = 'daily' | 'hourly';

type CsvRecord = LogRecord;

type CsvSinkOptions = {
  dir: string;
  rotation: Rotation;
  headers?: readonly string[];
  maxInMemoryQueue?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

const DEFAULT_HEADERS: readonly (keyof CsvRecord)[] = [
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

const RFC4180_NEEDS_QUOTE = /[",\r\n]/;

const DEFAULT_MAX_IN_MEMORY_QUEUE = 2048;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

type PendingEntry = {
  key: string;
  timestampUtc: string;
  serialized: string;
  attempt: number;
  nextAttemptAt: number;
};

const toTimestamp = (input: string): Date => {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return new Date();
  }
  return date;
};

const pad = (value: number): string => {
  return value.toString().padStart(2, '0');
};

const buildKey = (timestampUtc: string, rotation: Rotation): { key: string; file: string } => {
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
  private readonly dir: string;

  private readonly rotation: Rotation;

  private readonly headers: readonly string[];

  private readonly maxInMemoryQueue: number;

  private readonly retryBaseDelayMs: number;

  private readonly retryMaxDelayMs: number;

  private readonly retryQueue: PendingEntry[] = [];

  private retryTimer: NodeJS.Timeout | null = null;

  private activeKey: string | null = null;

  private handle: FileHandle | null = null;

  private queue: Promise<void> = Promise.resolve();

  private shuttingDown = false;

  private pendingWrites = 0;

  private totalWritten = 0;

  private lastError: string | null = null;

  private lastSuccessAt: Date | null = null;

  private dropTotal = 0;

  constructor(options: CsvSinkOptions) {
    this.dir = options.dir;
    this.rotation = options.rotation;
    this.headers = options.headers ?? DEFAULT_HEADERS;
    this.maxInMemoryQueue = options.maxInMemoryQueue ?? DEFAULT_MAX_IN_MEMORY_QUEUE;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  }

  public write(record: CsvRecord): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('CsvSink is shutting down'));
    }

    let entry: CsvRecord;
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

    const pending: PendingEntry = {
      key,
      timestampUtc: entry.timestamp_utc,
      serialized,
      attempt: 0,
      nextAttemptAt: Date.now(),
    };

    return this.enqueue(pending);
  }

  public async shutdown(): Promise<void> {
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

  private enqueue(entry: PendingEntry): Promise<void> {
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

  private async tryWrite(entry: PendingEntry): Promise<void> {
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

  private scheduleRetry(entry: PendingEntry): void {
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

  private scheduleRetryTimer(): void {
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

  private async flushRetryQueue(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    const now = Date.now();
    const ready: PendingEntry[] = [];
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

  private recordDrop(reason: string, entries: PendingEntry | PendingEntry[]): void {
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

  private async rotateIfNeeded(key: string, timestampUtc: string): Promise<void> {
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

  private async append(serialized: string): Promise<void> {
    if (!this.handle) {
      throw new Error('File handle is not initialized');
    }
    await this.handle.appendFile(serialized, 'utf8');
    await this.handle.datasync();
  }

  private async closeHandle(): Promise<void> {
    if (!this.handle) {
      return;
    }
    await this.handle.close();
    this.handle = null;
    this.activeKey = null;
  }

  public getMetrics(): {
    totalWritten: number;
    queueDepth: number;
    dropTotal: number;
    retryQueueDepth: number;
  } {
    return {
      totalWritten: this.totalWritten,
      queueDepth: this.pendingWrites + this.retryQueue.length,
      dropTotal: this.dropTotal,
      retryQueueDepth: this.retryQueue.length,
    };
  }

  public getHealthStatus(): {
    healthy: boolean;
    state: 'ok' | 'degraded' | 'shutting_down';
    shuttingDown: boolean;
    lastError: string | null;
    lastSuccessAt: Date | null;
    pendingWrites: number;
    totalWritten: number;
    dropTotal: number;
  } {
    const shuttingDown = this.shuttingDown;
    const hasError = this.lastError !== null;
    const state: 'ok' | 'degraded' | 'shutting_down' = shuttingDown
      ? 'shutting_down'
      : hasError
        ? 'degraded'
        : 'ok';

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

  private serialize(record: CsvRecord): string {
    const values = this.headers.map((key) => {
      const raw = (record as Record<string, unknown>)[key];
      return this.formatCell(raw);
    });
    return `${values.join(',')}\r\n`;
  }

  private formatCell(value: unknown): string {
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

export type { CsvRecord, CsvSinkOptions, Rotation };
export type CsvSinkMetrics = ReturnType<CsvSink['getMetrics']>;
export type CsvSinkHealthStatus = ReturnType<CsvSink['getHealthStatus']>;
export { CsvSink };
export default CsvSink;
