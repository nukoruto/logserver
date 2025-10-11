import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { parse, Parser } from 'csv-parse';

export const expectedColumns = [
  'timestamp_utc',
  'uid',
  'session_id',
  'method',
  'path',
  'referer',
  'user_agent',
  'ip',
  'op_category'
] as const;

const REQUIRED_VALUE_COLUMNS = new Set<keyof CsvRow>([
  'timestamp_utc',
  'uid',
  'session_id',
  'method',
  'path',
  'ip',
  'op_category'
]);

const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ParseCsvOptions {
  validateSchema?: boolean;
  expectedColumns?: readonly string[];
  onInvalidRow?: (info: InvalidRowInfo) => void;
}

export interface InvalidRowInfo {
  rowIndex: number;
  raw: Record<string, string>;
  reason: string;
  error?: Error;
}

export interface CsvRow {
  timestamp_utc: string;
  timestamp_epoch_seconds: number;
  uid: string;
  session_id: string;
  method: string;
  path: string;
  referer: string;
  user_agent: string;
  ip: string;
  op_category: string;
  row_index: number;
}

export interface CsvParseStats {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  invalidReasons: Record<string, number>;
  schemaValidated: boolean;
}

interface MutableStats {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  invalidReasons: Map<string, number>;
  schemaValidated: boolean;
}

interface NormalizedOptions {
  validateSchema: boolean;
  expectedColumns: readonly string[];
  onInvalidRow?: (info: InvalidRowInfo) => void;
}

export class CsvSchemaError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CsvSchemaError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function ensureReadable(input: string | Readable): Readable {
  if (typeof input === 'string') {
    try {
      return createReadStream(input, { encoding: 'utf8' });
    } catch (error) {
      throw new CsvSchemaError(`Failed to open CSV source: ${input}`, error);
    }
  }
  return input;
}

function normalizeOptions(options: ParseCsvOptions = {}): NormalizedOptions {
  return {
    validateSchema: options.validateSchema !== false,
    expectedColumns: options.expectedColumns ?? [...expectedColumns],
    onInvalidRow: options.onInvalidRow
  };
}

function validateHeader(header: string[], normalized: NormalizedOptions): void {
  if (!normalized.validateSchema) {
    return;
  }
  const missing = normalized.expectedColumns.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new CsvSchemaError(`Missing required columns: ${missing.join(', ')}`);
  }
}

function parseTimestamp(value: string): number {
  if (!RFC3339_REGEX.test(value)) {
    throw new CsvSchemaError('invalid_timestamp_format', value);
  }
  const epochMs = Date.parse(value);
  if (Number.isNaN(epochMs)) {
    throw new CsvSchemaError('invalid_timestamp_value', value);
  }
  return epochMs / 1000;
}

type ProcessResult =
  | { ok: true; value: Omit<CsvRow, 'row_index'> }
  | { ok: false; reason: string; error?: Error };

class CsvStreamParser implements AsyncIterable<CsvRow> {
  private readonly stream: Readable;

  private readonly parser: Parser;

  private readonly pipeline: Readable;

  private readonly options: NormalizedOptions;

  private readonly stats: MutableStats = {
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    invalidReasons: new Map(),
    schemaValidated: false
  };

  private consumed = false;

  constructor(input: string | Readable, options: ParseCsvOptions = {}) {
    this.options = normalizeOptions(options);
    this.stream = ensureReadable(input);
    this.parser = parse({
      bom: true,
      columns: (header: string[]): string[] => {
        validateHeader(header, this.options);
        this.stats.schemaValidated = this.options.validateSchema;
        return header;
      },
      skip_empty_lines: true,
      trim: true
    });
    this.pipeline = this.stream.pipe(this.parser);
  }

  getStats(): CsvParseStats {
    return {
      totalRows: this.stats.totalRows,
      validRows: this.stats.validRows,
      invalidRows: this.stats.invalidRows,
      invalidReasons: Object.fromEntries(this.stats.invalidReasons.entries()),
      schemaValidated: this.stats.schemaValidated
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<CsvRow> {
    if (this.consumed) {
      throw new CsvSchemaError('CSV stream has already been consumed');
    }
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<CsvRow> {
    let rawRowIndex = 0;
    let emittedIndex = 0;
    try {
      for await (const record of this.pipeline as AsyncIterable<Record<string, string>>) {
        const result = this.processRecord(record);
        this.stats.totalRows = rawRowIndex + 1;
        if (result.ok) {
          const row: CsvRow = {
            ...result.value,
            row_index: emittedIndex
          };
          emittedIndex += 1;
          this.stats.validRows += 1;
          yield row;
        } else {
          this.stats.invalidRows += 1;
          const reason = result.reason;
          const current = this.stats.invalidReasons.get(reason) ?? 0;
          this.stats.invalidReasons.set(reason, current + 1);
          if (this.options.onInvalidRow) {
            this.options.onInvalidRow({
              rowIndex: rawRowIndex,
              raw: record,
              reason,
              error: result.error
            });
          }
        }
        rawRowIndex += 1;
      }
    } catch (error) {
      throw this.wrapError(error);
    } finally {
      this.cleanup();
    }
  }

  private processRecord(record: Record<string, string>): ProcessResult {
    for (const column of this.options.expectedColumns) {
      if (record[column] === undefined) {
        return { ok: false, reason: `missing_column:${column}` };
      }
    }

    try {
      const timestampValue = record.timestamp_utc;
      if (timestampValue === undefined || timestampValue === '') {
        return { ok: false, reason: 'missing_timestamp' };
      }
      const timestampEpochSeconds = parseTimestamp(timestampValue);

      for (const column of REQUIRED_VALUE_COLUMNS) {
        const value = record[column];
        if (value === undefined || value === '') {
          return { ok: false, reason: `missing_value:${column}` };
        }
      }

      return {
        ok: true,
        value: {
          timestamp_utc: timestampValue,
          timestamp_epoch_seconds: timestampEpochSeconds,
          uid: record.uid ?? '',
          session_id: record.session_id ?? '',
          method: record.method ?? '',
          path: record.path ?? '',
          referer: record.referer ?? '',
          user_agent: record.user_agent ?? '',
          ip: record.ip ?? '',
          op_category: record.op_category ?? ''
        }
      };
    } catch (error) {
      if (error instanceof CsvSchemaError) {
        return { ok: false, reason: error.message, error };
      }
      return { ok: false, reason: 'unexpected_error', error: error instanceof Error ? error : undefined };
    }
  }

  private wrapError(error: unknown): CsvSchemaError {
    if (error instanceof CsvSchemaError) {
      return error;
    }
    return new CsvSchemaError('Failed to parse CSV stream', error);
  }

  private cleanup(): void {
    const destroyReadable = (stream: Readable | Parser): void => {
      const destroy = (stream as { destroy?: () => void }).destroy;
      if (typeof destroy === 'function') {
        destroy.call(stream);
      }
    };
    destroyReadable(this.pipeline);
    destroyReadable(this.parser);
    destroyReadable(this.stream);
  }
}

export function parseCsv(input: string | Readable, options: ParseCsvOptions = {}): CsvStreamParser {
  return new CsvStreamParser(input, options);
}

export { forEachUser } from './grouping.js';
export type { UserGroupedRow, UserCallback } from './grouping.js';
