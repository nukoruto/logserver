import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { parse, Parser } from 'csv-parse';
import { z } from 'zod';

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

const RFC3339_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export type OpCategory = 'AUTH' | 'READ' | 'UPDATE';

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
  op_category: OpCategory;
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

function assertFinite(value: number, message: string, cause?: string): void {
  if (!Number.isFinite(value)) {
    throw new CsvSchemaError(message, cause);
  }
}

export function parseEpochSec(timestamp: string): number {
  const match = RFC3339_REGEX.exec(timestamp);
  if (!match) {
    throw new CsvSchemaError('invalid_timestamp_format', timestamp);
  }

  const [
    ,
    yearStr,
    monthStr,
    dayStr,
    hourStr,
    minuteStr,
    secondStr,
    fractionalStr = '',
    zone,
    sign,
    offsetHourStr,
    offsetMinuteStr
  ] = match;

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new CsvSchemaError('invalid_timestamp_value', timestamp);
  }

  const baseMs = Date.UTC(year, month - 1, day, hour, minute, second);
  assertFinite(baseMs, 'invalid_timestamp_value', timestamp);

  const baseDate = new Date(baseMs);
  if (
    baseDate.getUTCFullYear() !== year ||
    baseDate.getUTCMonth() + 1 !== month ||
    baseDate.getUTCDate() !== day ||
    baseDate.getUTCHours() !== hour ||
    baseDate.getUTCMinutes() !== minute ||
    baseDate.getUTCSeconds() !== second
  ) {
    throw new CsvSchemaError('invalid_timestamp_value', timestamp);
  }

  let fractionalSeconds = 0;
  if (fractionalStr !== '') {
    const scale = 10 ** fractionalStr.length;
    fractionalSeconds = Number(fractionalStr) / scale;
  }

  let offsetSeconds = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(offsetHourStr);
    const offsetMinutes = Number(offsetMinuteStr);
    if (offsetHours > 23 || offsetMinutes > 59) {
      throw new CsvSchemaError('invalid_timestamp_value', timestamp);
    }
    offsetSeconds = offsetHours * 3600 + offsetMinutes * 60;
    if (sign === '-') {
      offsetSeconds *= -1;
    }
  }

  const epochSeconds = baseMs / 1000 - offsetSeconds + fractionalSeconds;
  assertFinite(epochSeconds, 'invalid_timestamp_value', timestamp);

  return epochSeconds;
}

const optionalString = z.string().optional().transform((value) => value ?? '');

const rowSchema = z.object({
  timestamp_utc: z
    .string()
    .nonempty({ message: 'missing_timestamp' })
    .refine((value) => RFC3339_REGEX.test(value), { message: 'invalid_timestamp_format' }),
  uid: z.string().min(1, { message: 'missing_value:uid' }),
  session_id: z.string().min(1, { message: 'missing_value:session_id' }),
  method: z.string().min(1, { message: 'missing_value:method' }),
  path: z.string().min(1, { message: 'missing_value:path' }),
  referer: optionalString,
  user_agent: optionalString,
  ip: z.string().min(1, { message: 'missing_value:ip' }),
  op_category: z.custom<OpCategory>((value) => value === 'AUTH' || value === 'READ' || value === 'UPDATE', {
    message: 'invalid_value:op_category'
  })
});

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
    try {
      for await (const record of this.pipeline as AsyncIterable<Record<string, string>>) {
        const result = this.processRecord(record);
        this.stats.totalRows = rawRowIndex + 1;
        if (result.ok) {
          const row: CsvRow = {
            ...result.value,
            row_index: rawRowIndex
          };
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
      const schemaResult = rowSchema.safeParse(record);
      if (!schemaResult.success) {
        const issue = schemaResult.error.issues[0];
        const reason = issue?.message ?? 'invalid_row';
        return {
          ok: false,
          reason,
          error: new CsvSchemaError(reason, schemaResult.error)
        };
      }

      const normalized = schemaResult.data;
      const timestampEpochSeconds = parseEpochSec(normalized.timestamp_utc);

      return {
        ok: true,
        value: {
          timestamp_utc: normalized.timestamp_utc,
          timestamp_epoch_seconds: timestampEpochSeconds,
          uid: normalized.uid,
          session_id: normalized.session_id,
          method: normalized.method,
          path: normalized.path,
          referer: normalized.referer,
          user_agent: normalized.user_agent,
          ip: normalized.ip,
          op_category: normalized.op_category
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
export {
  computeDeltas
} from './delta.js';
export type {
  DeltaAnnotatedRow,
  DeltaComputationOptions,
  DeltaComputationResult,
  DeltaComputationStats,
  DeltaTimeLabel
} from './delta.js';
export {
  assignSessions
} from './session.js';
export type {
  AssignSessionsOptions,
  SessionAnnotatedRow,
  SessionIdentifierContext
} from './session.js';
