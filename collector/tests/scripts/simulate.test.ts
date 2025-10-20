import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('simulate CLI', () => {
  const collectorDir = path.resolve(__dirname, '../..');
  const repoRoot = path.resolve(collectorDir, '..');
  const scriptPath = path.resolve(repoRoot, 'scripts/simulate.ts');
  const jwtKey = 'c2ltdWxhdGVkLWp3dC1zZWNyZXQ=';
  const saltB64 = 'AAECAwQFBgcICQoLDA0ODw==';
  const healthReportPath = path.resolve(repoRoot, 'out', 'health.json');

  const removeHealthReport = () => {
    try {
      rmSync(healthReportPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  };

  const createNtpState = (p95Ms: number, lastMeasuredAt: Date = new Date()) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'simulate-ntp-'));
    const statePath = path.join(dir, 'ntp.json');
    writeFileSync(statePath, JSON.stringify({ p95_ms: p95Ms, lastMeasuredAt: lastMeasuredAt.toISOString() }));
    const cleanup = () => {
      rmSync(dir, { recursive: true, force: true });
    };
    return { statePath, cleanup };
  };

  const runSimulate = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', scriptPath, ...args], {
      cwd: collectorDir,
      encoding: 'utf8',
      env: { ...process.env, JWT_HMAC_KEY: jwtKey, SID_SALT_B64: saltB64, ...env },
    });

  it('shows help', () => {
    const result = runSimulate(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--delta-epsilon');
  });

  it('generates a scenario and persists files', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'simulate-cli-'));
    const ntpState = createNtpState(20);
    removeHealthReport();
    try {
      const result = runSimulate(
        [
          '--count',
          '5',
          '--anomalies',
          'time',
          '--seed',
          'jest-cli',
          '--output-dir',
          tempDir,
          '--run-id',
          'jest-cli',
          '--csv-file',
          'cli-events.csv',
          '--manifest-file',
          'cli-manifest.json',
          '--delta-epsilon',
          '0.005',
          '--time-anomaly-mode',
          'local',
          '--pretty',
        ],
        { SIM_LOG_DIR: tempDir, NTP_STATE_PATH: ntpState.statePath }
      );

      expect(result.status).toBe(0);
      const lines = result.stdout.split(/\r?\n/);
      const startLine = lines.findIndex((line) => line.trim().startsWith('{'));
      expect(startLine).toBeGreaterThanOrEqual(0);
      const jsonLines = lines.slice(startLine).filter((line) => line.length > 0);
      const jsonString = `${jsonLines.join('\n').trimEnd()}\n`;
      const payload = JSON.parse(jsonString);
      expect(payload.events).toHaveLength(5);
      expect(payload.summary.events).toBe(5);
      expect(payload.files.csvPath).toContain('cli-events.csv');
      expect(payload.files.manifestPath).toContain('cli-manifest.json');
      expect(payload.params.delta_epsilon).toBeCloseTo(0.005, 10);
      expect(payload.params.time_anomaly.mode).toBe('local');
      expect(existsSync(path.join(tempDir, 'cli-events.csv'))).toBe(true);
      expect(existsSync(path.join(tempDir, 'cli-manifest.json'))).toBe(true);
      expect(existsSync(healthReportPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      ntpState.cleanup();
      removeHealthReport();
    }
  });

  it('fails when NTP measurement is out of spec', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'simulate-cli-ntp-out-'));
    const ntpState = createNtpState(80);
    removeHealthReport();
    try {
      const result = runSimulate(
        [
          '--count',
          '3',
          '--output-dir',
          tempDir,
          '--run-id',
          'ntp-out',
        ],
        { SIM_LOG_DIR: tempDir, NTP_STATE_PATH: ntpState.statePath }
      );

      expect(result.status).toBe(2);
      expect(result.stderr.toLowerCase()).toContain('ntp');
      expect(existsSync(path.join(tempDir, 'cli-events.csv'))).toBe(false);
      expect(existsSync(path.join(tempDir, 'cli-manifest.json'))).toBe(false);
      expect(existsSync(healthReportPath)).toBe(true);
      const health = JSON.parse(readFileSync(healthReportPath, 'utf8')) as Record<string, unknown>;
      expect(health.status).toBe('unhealthy');
      expect(health.reason).toBe('NTP_OUT_OF_SPEC');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      ntpState.cleanup();
      removeHealthReport();
    }
  });

  it('fails when NTP measurement is stale', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'simulate-cli-ntp-stale-'));
    const staleDate = new Date(Date.now() - 5 * 60 * 1000);
    const ntpState = createNtpState(20, staleDate);
    removeHealthReport();
    try {
      const result = runSimulate(
        [
          '--count',
          '3',
          '--output-dir',
          tempDir,
          '--run-id',
          'ntp-stale',
        ],
        { SIM_LOG_DIR: tempDir, NTP_STATE_PATH: ntpState.statePath }
      );

      expect(result.status).toBe(2);
      expect(result.stderr.toLowerCase()).toContain('stale');
      expect(existsSync(path.join(tempDir, 'cli-events.csv'))).toBe(false);
      expect(existsSync(path.join(tempDir, 'cli-manifest.json'))).toBe(false);
      expect(existsSync(healthReportPath)).toBe(true);
      const health = JSON.parse(readFileSync(healthReportPath, 'utf8')) as Record<string, unknown>;
      expect(health.status).toBe('unhealthy');
      expect(health.reason).toBe('STALE_MEASUREMENT');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      ntpState.cleanup();
      removeHealthReport();
    }
  });
});

export {};
