import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { jwtToUid } from '../src/security/uid';

describe('log ingestion pseudonymisation', () => {
  const originalEnv = { ...process.env };

  const restoreEnv = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  };

  afterEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    restoreEnv();
  });

  it('stores only pseudonymous uid in CSV exports', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-csv-'));
    const rawJwt = 'abc.def.ghi';
    const hmacKey = 'deadbeefdeadbeefdeadbeefdeadbeef';

    process.env.CSV_ROOT = tmpDir;
    process.env.JWT_HMAC_KEY = hmacKey;
    delete process.env.CONFIG_PATH;

    jest.resetModules();
    jest.doMock('../src/storage/eventRepository', () => ({
      insertEvent: jest.fn(async (event) => ({
        ...event,
        id: 1,
        delta_t: 0,
        received_at: '2024-01-01T00:00:00.000Z',
      })),
      insertEventsBulk: jest.fn(),
      createSchema: jest.fn(),
      getEvents: jest.fn(),
      countEvents: jest.fn(),
    }));

    let stored;
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const logService = require('../src/services/logService');
      stored = await logService.ingestEvent({
        session_id: 'sess-123',
        jwt: rawJwt,
        event: 'login',
        timestamp: '2024-01-01T00:00:00.000Z',
        method: 'get',
        path: '/login',
      });

      const expectedUid = jwtToUid(rawJwt, hmacKey);
      expect(stored.user_id).toBe(expectedUid);
      expect(stored).not.toHaveProperty('jwt');

      const files = await fs.readdir(tmpDir);
      expect(files.length).toBe(1);
      const csvPath = path.join(tmpDir, files[0]);
      const csvContent = await fs.readFile(csvPath, 'utf8');
      expect(csvContent.includes(rawJwt)).toBe(false);
      expect(csvContent.includes(expectedUid)).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
