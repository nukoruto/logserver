import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { collectMetricsSnapshot } from '../src/metrics/snapshot';

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const buildCli = (): void => {
  const collectorDir = path.resolve(__dirname, '..');
  const tsconfigPath = path.resolve(collectorDir, 'tsconfig.build.json');
  const tscPath = path.resolve(collectorDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const distCliPath = path.resolve(collectorDir, '..', 'dist', 'collector', 'metrics', 'cli.js');

  if (fs.existsSync(distCliPath)) {
    return;
  }

  const result = spawnSync(process.execPath, [tscPath, '--project', tsconfigPath], {
    cwd: collectorDir,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`TypeScript build failed: ${result.stderr || result.stdout}`);
  }
};

describe('metrics snapshot', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const keysToRestore = [
    'LOG_DIR',
    'APP_TIMEZONE',
    'GPU_MODE',
    'JWT_HMAC_KEY',
    'CSV_ROTATION',
    'NODE_ENV',
    'GIT_COMMIT',
  ];

  beforeEach(() => {
    for (const key of keysToRestore) {
      originalEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keysToRestore) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('hashes environment variables without leaking raw values', () => {
    process.env.LOG_DIR = '/var/logs';
    process.env.APP_TIMEZONE = 'UTC';
    process.env.GPU_MODE = 'ada6000';
    process.env.JWT_HMAC_KEY = 'super-secret-key';
    process.env.CSV_ROTATION = 'daily';
    process.env.NODE_ENV = 'test';
    process.env.GIT_COMMIT = 'commit-test';

    const logDir = process.env.LOG_DIR ?? '';
    const timezone = process.env.APP_TIMEZONE ?? '';
    const gpuMode = process.env.GPU_MODE ?? '';
    const jwtKey = process.env.JWT_HMAC_KEY ?? '';

    const snapshot = collectMetricsSnapshot();

    expect(snapshot.env_hash.LOG_DIR).toBe(hash(logDir));
    expect(snapshot.env_hash.APP_TIMEZONE).toBe(hash(timezone));
    expect(snapshot.env_hash.GPU_MODE).toBe(hash(gpuMode));
    expect(snapshot.env_hash.JWT_HMAC_KEY).toBe(hash(jwtKey));

    const expectedConfigHash = hash(
      ['JWT_HMAC_KEY', 'LOG_DIR', 'CSV_ROTATION', 'APP_TIMEZONE', 'GPU_MODE', 'NODE_ENV']
        .map((key) => `${key}=${process.env[key] ?? ''}`)
        .join('\n'),
    );
    expect(snapshot.config_hash).toBe(expectedConfigHash);
    expect(snapshot.git_commit).toBe('commit-test');
    expect(JSON.stringify(snapshot)).not.toContain(jwtKey);
  });

  it('CLI print emits stable JSON without leaking secrets', () => {
    buildCli();
    const repoRoot = path.resolve(__dirname, '..', '..');
    const cliPath = path.resolve(repoRoot, 'dist', 'collector', 'metrics', 'cli.js');
    const envForCli = {
      ...process.env,
      LOG_DIR: '/var/log/collector',
      APP_TIMEZONE: 'Asia/Tokyo',
      GPU_MODE: '4060',
      JWT_HMAC_KEY: 'cli-secret-key',
      CSV_ROTATION: 'hourly',
      NODE_ENV: 'production',
      GIT_COMMIT: 'cli-commit',
    } as NodeJS.ProcessEnv;

    const run = () => {
      const result = spawnSync(process.execPath, [cliPath, 'print'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: envForCli,
      });
      expect(result.status).toBe(0);
      const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
      const jsonLine = lines.find((line) => line.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const payload = JSON.parse(jsonLine as string) as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toContain('cli-secret-key');
      return payload;
    };

    const first = run();
    const second = run();

    expect(first.env_hash).toMatchObject({
      LOG_DIR: hash(envForCli.LOG_DIR ?? ''),
      APP_TIMEZONE: hash(envForCli.APP_TIMEZONE ?? ''),
      GPU_MODE: hash(envForCli.GPU_MODE ?? ''),
      JWT_HMAC_KEY: hash(envForCli.JWT_HMAC_KEY ?? ''),
    });

    const expectedConfigHash = hash(
      ['JWT_HMAC_KEY', 'LOG_DIR', 'CSV_ROTATION', 'APP_TIMEZONE', 'GPU_MODE', 'NODE_ENV']
        .map((key) => `${key}=${envForCli[key] ?? ''}`)
        .join('\n'),
    );

    expect(first.config_hash).toBe(expectedConfigHash);
    expect(second.config_hash).toBe(expectedConfigHash);
    expect(first.git_commit).toBe(envForCli.GIT_COMMIT);
    expect(second.git_commit).toBe(envForCli.GIT_COMMIT);

    delete (first as Record<string, unknown>).ts_utc;
    delete (second as Record<string, unknown>).ts_utc;

    expect(second).toEqual(first);
  });
});
