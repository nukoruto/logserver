import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetch } from 'undici';

type CsvRow = Record<string, string>;

type StartedServer = {
  process: ChildProcessWithoutNullStreams;
  logDir: string;
};

const PORT = 18453;
const TEST_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
const HMAC_KEY = '0123456789abcdef0123456789abcdef';
const CSV_BASENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:-\d{2})?\.csv$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const SENSITIVE_PATTERNS = [/authorization/i, /cookie/i];

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
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

const waitForServer = async (url: string, attempts = 40, intervalMs = 250): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }
    await delay(intervalMs);
  }

  throw new Error(`Server did not become ready at ${url}`);
};

const startServer = async (): Promise<StartedServer> => {
  const logDir = await mkdtemp(path.join(tmpdir(), 'logserver-security-'));
  const collectorDir = path.resolve(__dirname, '..', '..');
  const env = {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'test',
    CSV_ROOT: logDir,
    LOG_DIR: logDir,
    SQLITE_PATH: path.join(logDir, 'events.sqlite3'),
    JWT_HMAC_KEY: HMAC_KEY,
    CONFIG_PATH: path.join(logDir, 'test.env'),
    NTP_MONITOR_DISABLED: '1',
  };

  const child = spawn(process.execPath, ['server.js'], {
    cwd: collectorDir,
    env,
    stdio: 'pipe',
  });

  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);

  await waitForServer(`http://127.0.0.1:${PORT}/healthz`);

  return { process: child, logDir };
};

const stopServer = async (started: StartedServer | null): Promise<void> => {
  if (!started) {
    return;
  }

  const { process: child, logDir } = started;
  child.stdout?.removeAllListeners();
  child.stderr?.removeAllListeners();
  child.stdout?.destroy();
  child.stderr?.destroy();

  await new Promise<void>((resolve) => {
    const cleanup = () => resolve();
    child.once('exit', cleanup);
    child.once('close', cleanup);
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 5000);
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  });

  await rm(logDir, { recursive: true, force: true });
};

const sendEvent = async (sessionId: string, event: string): Promise<void> => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_JWT}`,
      cookie: `session_id=${sessionId}; csrftoken=csrf-token; other=secret`,
      'x-session-id': sessionId,
    },
    body: JSON.stringify({
      session_id: sessionId,
      event,
      timestamp: new Date().toISOString(),
      method: 'POST',
      path: '/api/v1/test',
      status: 200,
      jwt: TEST_JWT,
      metadata: { op_category: 'AUTH' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to send event: ${response.status} ${body}`);
  }

  await response.text();
};

const selectCsvFile = async (dir: string): Promise<string> => {
  const entries = await readdir(dir);
  const candidates = entries
    .filter((entry) => entry.endsWith('.csv'))
    .filter((entry) => CSV_BASENAME_PATTERN.test(entry));
  if (candidates.length === 0) {
    throw new Error(`No CSV files found in ${dir}`);
  }
  candidates.sort();
  return path.join(dir, candidates[candidates.length - 1]);
};

const loadCsv = async (dir: string): Promise<{ header: string[]; rows: CsvRow[]; content: string; filePath: string }> => {
  const filePath = await selectCsvFile(dir);
  const content = await readFile(filePath, 'utf8');
  const parsed = parseCsv(content);
  return { ...parsed, content, filePath };
};

describe('E2E security regression', () => {
  jest.setTimeout(60000);

  let server: StartedServer | null = null;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await stopServer(server);
  });

  it('redacts sensitive headers and keeps deterministic pseudonyms', async () => {
    await sendEvent('sess-security-1', 'login');
    await sendEvent('sess-security-2', 'update');

    await delay(750);

    if (!server) {
      throw new Error('Server was not started');
    }

    const { header, rows, content } = await loadCsv(server.logDir);

    expect(header).toContain('uid');

    const eventRows = rows.filter((row) => row.path === '/api/v1/events');
    expect(eventRows.length).toBeGreaterThanOrEqual(2);

    const uids = eventRows.map((row) => row.uid);
    for (const uid of uids) {
      expect(HEX64_PATTERN.test(uid)).toBe(true);
    }

    const uniqueUids = new Set(uids);
    expect(uniqueUids.size).toBe(1);

    for (const pattern of SENSITIVE_PATTERNS) {
      expect(pattern.test(content)).toBe(false);
    }
  });
});
