import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fetch } from 'undici';

type CliOptions = {
  logDir?: string;
  port: number;
};

type CsvRow = Record<string, string>;

const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const CSV_EXTENSION = '.csv';
const REQUIRED_COLUMNS = [
  'timestamp_utc',
  'uid',
  'session_id',
  'method',
  'path',
  'op_category',
];
const AUTHORIZATION_PATTERN = /authorization/i;
const COOKIE_PATTERN = /cookie/i;

const DEFAULT_JWT = 'header.payload.signature';
const DEFAULT_HMAC_KEY = '0123456789abcdeffedcba9876543210';

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = { port: 8123 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--log-dir' || arg === '--logDir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--log-dir requires a path');
      }
      options.logDir = value;
      index += 1;
    } else if (arg === '--port') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--port requires a value');
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--port must be a positive integer');
      }
      options.port = parsed;
      index += 1;
    }
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

const parseCsv = (content: string): { header: string[]; rows: CsvRow[] } => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  const header = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const rawValues = parseCsvLine(lines[lineIndex]);
    const record: CsvRow = {};
    header.forEach((column, columnIndex) => {
      record[column] = rawValues[columnIndex] ?? '';
    });
    rows.push(record);
  }

  return { header, rows };
};

const ensureColumns = (header: string[]): void => {
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`Missing required CSV columns: ${missing.join(', ')}`);
  }
};

const waitForServer = async (url: string, retries = 20): Promise<void> => {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }
    await delay(500);
  }
  throw new Error(`Server did not become healthy at ${url}`);
};

const resolveLogDir = async (requested?: string): Promise<{ dir: string; created: boolean }> => {
  if (requested) {
    await mkdir(requested, { recursive: true });
    return { dir: requested, created: false };
  }
  const tmp = await mkdtemp(path.join(tmpdir(), 'logserver-e2e-'));
  return { dir: tmp, created: true };
};

const startServer = (port: number, logDir: string): { child: ReturnType<typeof spawn>; terminate: () => Promise<void> } => {
  const collectorDir = path.resolve(__dirname, '..');
  const sqlitePath = path.join(logDir, 'events.sqlite3');
  const env = {
    ...process.env,
    PORT: String(port),
    CSV_ROOT: logDir,
    LOG_DIR: logDir,
    SQLITE_PATH: sqlitePath,
    JWT_HMAC_KEY: process.env.JWT_HMAC_KEY || DEFAULT_HMAC_KEY,
    NODE_ENV: 'test',
  };

  const child = spawn(process.execPath, ['server.js'], {
    cwd: collectorDir,
    env,
    stdio: ['ignore', createWriteStream(path.join(logDir, 'server.stdout.log')), createWriteStream(path.join(logDir, 'server.stderr.log'))],
  });

  const terminate = async (): Promise<void> => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    });
  };

  return { child, terminate };
};

const sendJson = async (
  url: string,
  init: { method: string; sessionId: string; jwt: string; body: Record<string, unknown> }
): Promise<void> => {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${init.jwt}`,
    cookie: `session_id=${init.sessionId}; csrftoken=test`,
    'x-session-id': init.sessionId,
  };
  const response = await fetch(url, {
    method: init.method,
    headers,
    body: JSON.stringify(init.body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request to ${url} failed with ${response.status}: ${text}`);
  }
};

const runE2E = async (port: number): Promise<void> => {
  const baseUrl = `http://127.0.0.1:${port}`;
  const requests = [
    {
      kind: 'AUTH',
      execute: () =>
        sendJson(`${baseUrl}/api/v1/events`, {
          method: 'POST',
          sessionId: 'sess-auth',
          jwt: DEFAULT_JWT,
          body: {
            session_id: 'sess-auth',
            event: 'login',
            method: 'POST',
            path: '/auth/login',
            status: 200,
            jwt: DEFAULT_JWT,
            metadata: { op_category: 'AUTH' },
          },
        }),
    },
    {
      kind: 'READ',
      execute: () =>
        fetch(`${baseUrl}/api/v1/health`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${DEFAULT_JWT}`,
            cookie: 'session_id=sess-read; csrftoken=test',
            'user-agent': 'logserver-e2e',
          },
        }).then((response) => {
          if (!response.ok) {
            return response.text().then((text) => {
              throw new Error(`Health request failed with ${response.status}: ${text}`);
            });
          }
        }),
    },
    {
      kind: 'UPDATE',
      execute: () =>
        sendJson(`${baseUrl}/api/v1/events`, {
          method: 'POST',
          sessionId: 'sess-update',
          jwt: DEFAULT_JWT,
          body: {
            session_id: 'sess-update',
            event: 'profile_update',
            method: 'PUT',
            path: '/profile',
            status: 204,
            jwt: DEFAULT_JWT,
            metadata: { op_category: 'UPDATE' },
          },
        }),
    },
  ];

  for (const request of requests) {
    await request.execute();
  }
};

const readCsvRecords = async (logDir: string): Promise<{ file: string; rows: CsvRow[]; header: string[] }> => {
  const entries = await readdir(logDir);
  const csvFiles = entries.filter((entry) => entry.endsWith(CSV_EXTENSION));
  if (csvFiles.length === 0) {
    throw new Error(`No CSV files found in ${logDir}`);
  }
  csvFiles.sort();
  const selected = csvFiles[csvFiles.length - 1];
  const filePath = path.join(logDir, selected);
  const stats = await stat(filePath);
  if (stats.size === 0) {
    throw new Error(`CSV file ${filePath} is empty`);
  }
  const content = await readFile(filePath, 'utf8');
  const parsed = parseCsv(content);
  ensureColumns(parsed.header);
  return { file: filePath, rows: parsed.rows, header: parsed.header };
};

const assertDeterministicUid = (rows: CsvRow[]): void => {
  const uids = new Set(rows.map((row) => row.uid));
  if (uids.size !== 1) {
    throw new Error(`Expected deterministic UID but found ${uids.size} distinct values`);
  }
};

const assertTimestamps = (rows: CsvRow[]): void => {
  for (const row of rows) {
    const value = row.timestamp_utc;
    if (!RFC3339_PATTERN.test(value)) {
      throw new Error(`timestamp_utc is not RFC3339: ${value}`);
    }
  }
};

const assertCategories = (rows: CsvRow[]): void => {
  const categories = rows.map((row) => row.op_category);
  const allowed = new Set(['AUTH', 'READ', 'UPDATE']);
  for (const category of categories) {
    if (!allowed.has(category)) {
      throw new Error(`Invalid operation category recorded: ${category}`);
    }
  }
};

const assertSanitization = (content: string): void => {
  if (AUTHORIZATION_PATTERN.test(content) || COOKIE_PATTERN.test(content)) {
    throw new Error('Sensitive headers leaked into CSV output');
  }
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const { dir: logDir, created } = await resolveLogDir(options.logDir);
  const { terminate } = startServer(options.port, logDir);

  try {
    await waitForServer(`http://127.0.0.1:${options.port}/healthz`);
    await runE2E(options.port);
    await delay(1000);
    const { file, rows, header } = await readCsvRecords(logDir);
    if (rows.length < 3) {
      throw new Error(`Expected at least 3 log rows, found ${rows.length}`);
    }
    assertDeterministicUid(rows);
    assertTimestamps(rows);
    assertCategories(rows);
    const content = await readFile(file, 'utf8');
    assertSanitization(content);
    console.log(JSON.stringify({ logFile: file, rows: rows.length, header }));
  } finally {
    await terminate();
    if (created) {
      await rm(logDir, { recursive: true, force: true });
    }
  }
};

main().catch((error) => {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
