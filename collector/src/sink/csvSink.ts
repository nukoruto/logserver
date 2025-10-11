import { mkdir, open } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import path from 'path';
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

  private activeKey: string | null = null;

  private handle: FileHandle | null = null;

  private queue: Promise<void> = Promise.resolve();

  private shuttingDown = false;

  constructor(options: CsvSinkOptions) {
    this.dir = options.dir;
    this.rotation = options.rotation;
    this.headers = options.headers ?? DEFAULT_HEADERS;
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

    const operation = this.queue.then(async () => {
      await this.rotateIfNeeded(key, entry.timestamp_utc);
      await this.append(serialized);
    });

    this.queue = operation.catch(() => undefined);

    return operation;
  }

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      await this.queue;
      return;
    }
    this.shuttingDown = true;
    await this.queue;
    await this.closeHandle();
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
export { CsvSink };
export default CsvSink;
