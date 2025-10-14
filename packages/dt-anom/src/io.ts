import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, format } from 'fast-csv';
import { anomalyMetaSchema, anomalyStatsSchema, type AnomalyMeta, type AnomalyStats } from './schema.js';
import { toFiniteNumber } from './utils.js';

export interface CsvLoadOptions {
  readonly column: string;
}

export interface CsvLoadResult {
  readonly values: number[];
  readonly rowCount: number;
}

export interface GroupedSample {
  readonly uid: string;
  readonly opCategory: string;
  readonly value: number;
}

export interface GroupedCsvLoadResult {
  readonly samples: GroupedSample[];
  readonly rowCount: number;
}

export interface DtRecord {
  readonly index: number;
  readonly uid: string;
  readonly opCategory: string;
  readonly dt: number;
  readonly logDt?: number;
  readonly zDeseas?: number;
  readonly timestampUtc?: string;
}

export interface DtRecordLoadOptions {
  readonly dtColumn: string;
  readonly logDtColumn: string;
  readonly zDeseasColumn: string;
}

export interface DtRecordLoadResult {
  readonly records: DtRecord[];
  readonly rowCount: number;
}

export async function loadNumericColumn(files: readonly string[], options: CsvLoadOptions): Promise<CsvLoadResult> {
  const values: number[] = [];
  let rowCount = 0;
  for (const file of files) {
    await new Promise<void>((resolve, reject) => {
      createReadStream(file)
        .pipe(parse({ headers: true, ignoreEmpty: true, trim: true }))
        .on('error', reject)
        .on('data', (row: Record<string, unknown>) => {
          rowCount += 1;
          const raw = row[options.column];
          if (raw === undefined || raw === null) {
            return;
          }
          try {
            const value = toFiniteNumber(raw, options.column);
            values.push(value);
          } catch {
            /* ignore non numeric rows */
          }
        })
        .on('end', () => resolve());
    });
  }
  return { values, rowCount };
}

export async function loadGroupedNumericColumn(
  files: readonly string[],
  options: CsvLoadOptions
): Promise<GroupedCsvLoadResult> {
  const samples: GroupedSample[] = [];
  let rowCount = 0;
  for (const file of files) {
    await new Promise<void>((resolve, reject) => {
      createReadStream(file)
        .pipe(parse({ headers: true, ignoreEmpty: true, trim: true }))
        .on('error', reject)
        .on('data', (row: Record<string, unknown>) => {
          rowCount += 1;
          const raw = row[options.column];
          const uidRaw = row.uid;
          const categoryRaw = row.op_category;
          if (raw === undefined || raw === null || uidRaw === undefined || categoryRaw === undefined) {
            return;
          }
          try {
            const value = toFiniteNumber(raw, options.column);
            const uid = String(uidRaw);
            const opCategory = String(categoryRaw);
            if (uid.length === 0 || opCategory.length === 0) {
              return;
            }
            samples.push({ uid, opCategory, value });
          } catch {
            /* ignore non numeric rows */
          }
        })
        .on('end', () => resolve());
    });
  }
  return { samples, rowCount };
}

export async function loadDtRecords(
  files: readonly string[],
  options: DtRecordLoadOptions
): Promise<DtRecordLoadResult> {
  const records: DtRecord[] = [];
  let rowCount = 0;
  let index = 0;
  for (const file of files) {
    await new Promise<void>((resolve, reject) => {
      createReadStream(file)
        .pipe(parse({ headers: true, ignoreEmpty: true, trim: true }))
        .on('error', reject)
        .on('data', (row: Record<string, unknown>) => {
          rowCount += 1;
          const uidRaw = row.uid;
          const categoryRaw = row.op_category;
          const dtRaw = row[options.dtColumn];
          if (uidRaw === undefined || categoryRaw === undefined || dtRaw === undefined) {
            return;
          }
          const uid = String(uidRaw).trim();
          const opCategory = String(categoryRaw).trim();
          if (uid.length === 0 || opCategory.length === 0) {
            return;
          }
          try {
            const dt = toFiniteNumber(dtRaw, options.dtColumn);
            const record: DtRecord = {
              index,
              uid,
              opCategory,
              dt,
              timestampUtc: typeof row.timestamp_utc === 'string' ? row.timestamp_utc : undefined
            };
            const logDtRaw = row[options.logDtColumn];
            if (logDtRaw !== undefined && logDtRaw !== null && String(logDtRaw).length > 0) {
              try {
                record.logDt = toFiniteNumber(logDtRaw, options.logDtColumn);
              } catch {
                /* ignore */
              }
            }
            const zDeseasRaw = row[options.zDeseasColumn];
            if (zDeseasRaw !== undefined && zDeseasRaw !== null && String(zDeseasRaw).length > 0) {
              try {
                record.zDeseas = toFiniteNumber(zDeseasRaw, options.zDeseasColumn);
              } catch {
                /* ignore */
              }
            }
            records.push(record);
            index += 1;
          } catch {
            /* ignore */
          }
        })
        .on('end', () => resolve());
    });
  }
  return { records, rowCount };
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJsonFile<T>(path: string, data: T): Promise<void> {
  const dir = dirname(path);
  if (dir && dir !== '.') {
    await ensureDir(dir);
  }
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

export async function readAnomalyStats(path: string): Promise<AnomalyStats> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  return anomalyStatsSchema.parse(parsed);
}

export async function readAnomalyMeta(path: string): Promise<AnomalyMeta> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  return anomalyMetaSchema.parse(parsed);
}

export async function streamCsvWithAppend(
  inputPath: string,
  outputPath: string,
  transform: (row: Record<string, string>) => Record<string, string>
): Promise<number> {
  await ensureDir(dirname(outputPath));
  return await new Promise<number>((resolve, reject) => {
    let processed = 0;
    const parser = parse({ headers: true, ignoreEmpty: true, trim: true });
    const formatter = format({ headers: true });
    formatter.pipe(createWriteStream(outputPath, { encoding: 'utf8' })).on('error', reject);
    formatter.on('finish', () => resolve(processed));
    createReadStream(inputPath)
      .pipe(parser)
      .on('error', reject)
      .on('data', (row: Record<string, string>) => {
        processed += 1;
        const next = transform(row);
        formatter.write(next);
      })
      .on('end', () => {
        formatter.end();
      });
  });
}
