import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

type AuditOptions = {
  paths: string[];
  failOnError: boolean;
};

type CsvRow = Record<string, string>;

type AuditFinding = {
  file: string;
  line: number;
  message: string;
};

const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const OP_CATEGORIES = new Set(['AUTH', 'READ', 'UPDATE']);
const CSV_EXTENSION = '.csv';

const parseArgs = (argv: string[]): AuditOptions => {
  const options: AuditOptions = { paths: [], failOnError: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir' || arg === '--path') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options.paths.push(value);
      index += 1;
    } else if (arg === '--fail-on-error' || arg === '--fail') {
      options.failOnError = true;
    }
  }

  if (options.paths.length === 0) {
    throw new Error('At least one --dir or --path argument is required');
  }
  return options;
};

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
};

const parseCsvContent = (content: string): { header: string[]; rows: CsvRow[] } => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  const header = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index]);
    const record: CsvRow = {};
    header.forEach((column, columnIndex) => {
      record[column] = values[columnIndex] ?? '';
    });
    rows.push(record);
  }

  return { header, rows };
};

const collectCsvFiles = async (inputs: readonly string[]): Promise<string[]> => {
  const results: string[] = [];

  const traverse = async (target: string): Promise<void> => {
    const stats = await stat(target);
    if (stats.isDirectory()) {
      const entries = await readdir(target);
      await Promise.all(entries.map((entry) => traverse(path.join(target, entry))));
      return;
    }
    if (stats.isFile() && target.endsWith(CSV_EXTENSION)) {
      results.push(target);
    }
  };

  for (const input of inputs) {
    await traverse(path.resolve(process.cwd(), input));
  }

  return results;
};

const validateRow = (
  row: CsvRow,
  file: string,
  lineNumber: number,
  header: readonly string[],
  findings: AuditFinding[]
): void => {
  const method = row.method || '';
  const timestamp = row.timestamp_utc || '';
  const category = row.op_category || '';

  if (!RFC3339_PATTERN.test(timestamp)) {
    findings.push({ file, line: lineNumber, message: `timestamp_utc not RFC3339: ${timestamp}` });
  }
  if (!HTTP_METHODS.has(method)) {
    findings.push({ file, line: lineNumber, message: `Invalid HTTP method: ${method}` });
  }
  if (!OP_CATEGORIES.has(category)) {
    findings.push({ file, line: lineNumber, message: `Invalid op_category: ${category}` });
  }

  for (const required of ['timestamp_utc', 'method', 'op_category']) {
    if (!header.includes(required)) {
      findings.push({ file, line: 1, message: `Missing column ${required}` });
    }
  }
};

const audit = async (options: AuditOptions): Promise<number> => {
  const files = await collectCsvFiles(options.paths);
  if (files.length === 0) {
    throw new Error(`No CSV files found under: ${options.paths.join(', ')}`);
  }

  const findings: AuditFinding[] = [];
  let totalRows = 0;

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const { header, rows } = parseCsvContent(content);
    totalRows += rows.length;
    rows.forEach((row, index) => {
      validateRow(row, file, index + 2, header, findings);
    });
  }

  if (findings.length > 0) {
    findings.forEach((finding) => {
      console.error(`${finding.file}:${finding.line} ${finding.message}`);
    });
  }

  console.log(JSON.stringify({ files: files.length, rows: totalRows, findings: findings.length }));

  if (findings.length > 0 && options.failOnError) {
    return 1;
  }
  return 0;
};

const main = async (): Promise<void> => {
  try {
    const options = parseArgs(process.argv.slice(2));
    const exitCode = await audit(options);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(`[audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

main();

export { audit, parseArgs };
export type { AuditOptions };
