import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface CliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(packageRoot, 'src', 'cli.ts');

async function runCli(args: readonly string[]): Promise<CliRunResult> {
  const child = spawn(
    process.execPath,
    ['--loader', 'ts-node/esm', cliPath, ...args],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(packageRoot, 'tsconfig.json')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return await new Promise<CliRunResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        stdout,
        stderr,
        code: typeof code === 'number' ? code : 1
      });
    });
  });
}

describe('dt-anom CLI end-to-end', () => {
  it('fits and scores via CLI commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dt-anom-cli-'));
    const inputPath = join(dir, 'train.csv');
    const statsPath = join(dir, 'stats.json');
    const metaPath = join(dir, 'meta.json');
    const scoreInputPath = join(dir, 'score.csv');
    const scoreOutputPath = join(dir, 'scored.csv');
    const auditPath = join(dir, 'audit.jsonl');

    try {
      const csv = [
        'timestamp_utc,uid,session_id,method,path,referer,user_agent,op_category,dt_sec,log_dt,z,z_clipped,z_deseas',
        '2024-01-01T00:00:00Z,u1,s1,GET,/login,-,UA1,AUTH,1.0,0.0,0.2,0.2,0.1',
        '2024-01-01T00:00:01Z,u1,s1,POST,/login,-,UA1,AUTH,1.2,0.18,0.3,0.3,0.0',
        '2024-01-01T00:00:06Z,u1,s1,POST,/admin,-,UA1,UPDATE,5.0,0.70,4.5,4.5,4.0',
        '2024-01-01T00:00:07Z,u1,s1,GET,/dashboard,-,UA1,READ,0.9,0.0,0.1,0.1,0.05',
        '2024-01-01T00:00:09Z,u1,s1,POST,/update,-,UA1,UPDATE,2.5,0.40,2.1,2.1,1.9',
        '2024-01-01T00:00:14Z,u1,s1,POST,/admin/delete,-,UA1,UPDATE,6.2,0.79,4.2,4.2,3.9',
        '2024-01-01T00:00:15Z,u1,s1,GET,/logout,-,UA1,AUTH,0.8,-0.10,0.05,0.05,0.02'
      ].join('\n');

      await writeFile(inputPath, csv, 'utf8');

      const fitResult = await runCli([
        'fit',
        '-i',
        inputPath,
        '-s',
        statsPath,
        '-m',
        metaPath,
        '--preproc-hash',
        'e2e-cli-test',
        '--quantile-lower',
        '0.1',
        '--quantile-upper',
        '0.9',
        '--min-quantile-samples',
        '2',
        '--budget-total',
        '0.05',
        '--spot-domain',
        'log_dt',
        '--spot-calib-count',
        '5',
        '--spot-p0',
        '0.9,0.95,0.99',
        '--min-tail',
        '2',
        '--flag-tail-prob',
        '0.001',
        '--alpha',
        '0.6',
        '--q',
        '0.995',
        '--calib-window',
        '500',
        '--decluster-r',
        '3',
        '--kofn',
        '1/3',
        '--H',
        '1.3',
        '--reestimate-every',
        '4',
        '--min-exceed',
        '2',
        '--pool-strategy',
        'per-user',
        '--xi-eps',
        '0.0001',
        '--upper-cap-per-day',
        '20',
        '--lower-clip',
        '-4',
        '--seed',
        '42'
      ]);

      expect(fitResult.code).toBe(0);
      const fitStderr = fitResult.stderr.trim();
      if (fitStderr.length > 0) {
        expect(fitStderr).toContain('ExperimentalWarning');
      }
      const fitStdout = fitResult.stdout.trim();
      expect(fitStdout.length).toBeGreaterThan(0);
      const fitPayload = JSON.parse(fitStdout);
      expect(fitPayload.stats.base_column).toBe('dt_sec');
      expect(fitPayload.meta.input_files).toEqual([inputPath]);

      const stats = JSON.parse(await readFile(statsPath, 'utf8'));
      expect(stats.spot.length).toBeGreaterThan(0);
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      expect(meta.preproc_hash).toBe('e2e-cli-test');
      expect(meta.budget.total).toBeCloseTo(0.05, 6);

      const scoreCsv =
        csv +
        '\n' +
        '2024-01-01T00:00:20Z,u1,s1,POST,/admin/purge,-,UA1,UPDATE,7.5,0.88,5.1,5.1,4.6';
      await writeFile(scoreInputPath, scoreCsv, 'utf8');

      const scoreResult = await runCli([
        'score',
        '-i',
        scoreInputPath,
        '-o',
        scoreOutputPath,
        '--stats',
        statsPath,
        '--meta',
        metaPath,
        '--audit',
        auditPath
      ]);

      expect(scoreResult.code).toBe(0);
      const scoreStderr = scoreResult.stderr.trim();
      if (scoreStderr.length > 0) {
        expect(scoreStderr).toContain('ExperimentalWarning');
      }
      const scoreSummary = JSON.parse(scoreResult.stdout.trim());
      expect(scoreSummary.processedRows).toBe(8);
      expect(scoreSummary.flaggedRows).toBeGreaterThan(0);

      const scoredContent = await readFile(scoreOutputPath, 'utf8');
      const lines = scoredContent.trim().split('\n');
      expect(lines.length).toBe(9);
      const header = lines[0].split(',');
      const alarmIndex = header.indexOf('alarm');
      expect(alarmIndex).toBeGreaterThanOrEqual(0);
      const flaggedRows = lines
        .slice(1)
        .map((line) => line.split(','))
        .filter((cols) => cols[alarmIndex] === '1');
      expect(flaggedRows.length).toBeGreaterThan(0);

      const auditContent = await readFile(auditPath, 'utf8');
      const auditLines = auditContent.trim().split('\n');
      expect(auditLines.length).toBeGreaterThanOrEqual(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
