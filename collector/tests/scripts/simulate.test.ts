import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('simulate CLI', () => {
  const collectorDir = path.resolve(__dirname, '../..');
  const repoRoot = path.resolve(collectorDir, '..');
  const scriptPath = path.resolve(repoRoot, 'scripts/simulate.ts');

  const runSimulate = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', scriptPath, ...args], {
      cwd: collectorDir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  it('shows help', () => {
    const result = runSimulate(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--delta-epsilon');
  });

  it('generates a scenario and persists files', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'simulate-cli-'));
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
        { SIM_LOG_DIR: tempDir }
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
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

export {};
