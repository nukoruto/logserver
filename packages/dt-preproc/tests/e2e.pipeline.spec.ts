import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parse as parseCsv } from 'csv-parse/sync';
import { describe, expect, test } from 'vitest';

type CliRunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

const dtPreprocRoot = fileURLToPath(new URL('..', import.meta.url));
const dtAnomRoot = fileURLToPath(new URL('../../dt-anom', import.meta.url));
const dtLstmRoot = fileURLToPath(new URL('../../dt-lstm', import.meta.url));
const dtLstmSrc = join(dtLstmRoot, 'src');
const fixturePath = fileURLToPath(new URL('../test/fixtures/pipeline_small.csv', import.meta.url));

async function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<CliRunResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

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

async function runPreprocCli(args: readonly string[]): Promise<CliRunResult> {
  const cliPath = join(dtPreprocRoot, 'src', 'cli.ts');
  return await runProcess(
    process.execPath,
    ['--loader', 'ts-node/esm', cliPath, ...args.map(String)],
    {
      cwd: dtPreprocRoot,
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(dtPreprocRoot, 'tsconfig.json')
      }
    }
  );
}

async function runAnomCli(args: readonly string[]): Promise<CliRunResult> {
  const cliPath = join(dtAnomRoot, 'src', 'cli.ts');
  return await runProcess(
    process.execPath,
    ['--loader', 'ts-node/esm', cliPath, ...args.map(String)],
    {
      cwd: dtAnomRoot,
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(dtAnomRoot, 'tsconfig.json')
      }
    }
  );
}

function resolvePythonExecutable(): string {
  return process.env.PYTHON ?? process.env.PYTHON_BIN ?? 'python3';
}

async function runDtLstmCli(args: readonly string[]): Promise<CliRunResult> {
  const python = resolvePythonExecutable();
  const pythonPathEntries = [dtLstmSrc];
  if (process.env.PYTHONPATH && process.env.PYTHONPATH.length > 0) {
    pythonPathEntries.push(process.env.PYTHONPATH);
  }
  return await runProcess(python, ['-m', 'dt_lstm.cli', ...args.map(String)], {
    cwd: dtLstmRoot,
    env: {
      ...process.env,
      PYTHONPATH: pythonPathEntries.join(delimiter),
      PYTHONNOUSERSITE: '1',
      CUDA_VISIBLE_DEVICES: '',
      GPU_MODE: 'cpu',
      OMP_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      PYTORCH_ENABLE_MPS_FALLBACK: '1'
    }
  });
}

function parseJsonPayload(output: string): unknown {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error('Expected JSON output but received empty stdout');
  }
  return JSON.parse(trimmed);
}

describe.sequential('Δt pipeline integration', () => {
  test('transform derives template_id for contract CSV input', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'dt-contract-'));
    try {
      const contractCsvPath = join(tempDir, 'contract.csv');
      const statsPath = join(tempDir, 'stats.json');
      const outputPath = join(tempDir, 'transformed.csv');
      const csvContent = [
        'timestamp_utc,uid,session_id,method,path,referer,user_agent,ip,op_category',
        '2024-01-01T00:00:00Z,u-1,s-1,GET,/login,-,UA,127.0.0.1,AUTH',
        '2024-01-01T00:00:05Z,u-1,s-1,POST,/logout,-,UA,127.0.0.1,AUTH'
      ].join('\n');
      await writeFile(contractCsvPath, `${csvContent}\n`, 'utf8');

      const fitResult = await runPreprocCli([
        'fit',
        '--in',
        contractCsvPath,
        '--out',
        statsPath,
        '--pretty'
      ]);
      expect(fitResult.code).toBe(0);

      const transformResult = await runPreprocCli([
        'transform',
        '--in',
        contractCsvPath,
        '--stats',
        statsPath,
        '--out',
        outputPath
      ]);
      expect(transformResult.code).toBe(0);

      const transformedCsv = await readFile(outputPath, 'utf8');
      const records = parseCsv(transformedCsv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
      expect(records).toHaveLength(2);
      expect(records[0].template_id).toBe('AUTH::GET::login');
      expect(records[0].event).toBe('AUTH::GET::login');
      expect(records[1].template_id).toBe('AUTH::POST::logout');
      expect(records[1].event).toBe('AUTH::POST::logout');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);

  test(
    'dt-preproc → dt-anom → dt-lstm CLI pipeline maintains dt_sec alias',
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'dt-pipeline-'));
      try {
        const preprocStatsPath = join(tempDir, 'preproc', 'stats.json');
        const preprocMetaPath = join(tempDir, 'preproc', 'meta.json');
        const transformedCsvPath = join(tempDir, 'preproc', 'transformed.csv');
        await mkdir(dirname(preprocStatsPath), { recursive: true });

        const preprocFit = await runPreprocCli([
          'fit',
          '--in',
          fixturePath,
          '--out',
          preprocStatsPath,
          '--meta',
          preprocMetaPath,
          '--pretty',
          '--grouping',
          'uid',
          '--epsilon-t',
          '0.05',
          '--clip-max',
          '300',
          '--robust-z-clip',
          '5',
          '--min-samples',
          '1',
          '--window',
          '5',
          '--quantiles',
          '0.25,0.5,0.75'
        ]);
        expect(preprocFit.code).toBe(0);
        const fitStderr = preprocFit.stderr.trim();
        if (fitStderr.length > 0) {
          expect(fitStderr).toContain('ExperimentalWarning');
        }

        const preprocTransform = await runPreprocCli([
          'transform',
          '--in',
          fixturePath,
          '--stats',
          preprocStatsPath,
          '--out',
          transformedCsvPath,
          '--validate-schema'
        ]);
        expect(preprocTransform.code).toBe(0);
        const transformStderr = preprocTransform.stderr.trim();
        if (transformStderr.length > 0) {
          expect(transformStderr).toContain('ExperimentalWarning');
        }

        const transformedCsv = await readFile(transformedCsvPath, 'utf8');
        const records = parseCsv(transformedCsv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
        expect(records.length).toBeGreaterThan(0);
        for (const row of records) {
          expect(row).toHaveProperty('template_id');
          expect(row.template_id?.length ?? 0).toBeGreaterThan(0);
          expect(row.event).toBe(row.template_id);
          expect(row).toHaveProperty('dt_sec');
          expect(row.dt_sec).toBe(row.delta_seconds);
        }
        const nonEmptyDtValues = records
          .map((row) => row.dt_sec)
          .filter((value) => value !== undefined && value.trim().length > 0);
        expect(nonEmptyDtValues.length).toBeGreaterThan(0);

        const measuredRecords = records.filter((row) => {
          const value = row.dt_sec?.trim();
          if (!value) {
            return false;
          }
          const parsed = Number(value);
          return Number.isFinite(parsed) && parsed > 0;
        });
        expect(measuredRecords.length).toBeGreaterThan(0);

        const anomDir = join(tempDir, 'anom');
        const anomInputPath = join(anomDir, 'pipeline_input.csv');
        await mkdir(anomDir, { recursive: true });
        const anomHeader = [
          'timestamp_utc',
          'uid',
          'session_id',
          'method',
          'path',
          'referer',
          'user_agent',
          'op_category',
          'dt_sec',
          'log_dt',
          'z',
          'z_clipped',
          'z_deseas'
        ].join(',');
        const anomLines = measuredRecords.map((row) => {
          const dtValue = Number(row.dt_sec);
          const logDt = Math.log(dtValue > 0 ? dtValue : Number.EPSILON);
          const field = (value: string | undefined) => (value ?? '').trim();
          return [
            field(row.timestamp_utc),
            field(row.uid),
            field(row.session_id),
            field(row.method),
            field(row.path),
            field(row.referer),
            field(row.user_agent),
            field(row.op_category),
            dtValue.toString(),
            logDt.toString(),
            '0',
            '0',
            '0'
          ].join(',');
        });
        await writeFile(anomInputPath, [anomHeader, ...anomLines].join('\n'), 'utf8');

        const anomStatsPath = join(anomDir, 'stats.json');
        const anomMetaPath = join(anomDir, 'meta.json');
        const scoredCsvPath = join(anomDir, 'scored.csv');
        const auditPath = join(anomDir, 'audit.jsonl');

        const anomFit = await runAnomCli([
          'fit',
          '-i',
          anomInputPath,
          '-s',
          anomStatsPath,
          '-m',
          anomMetaPath,
          '--preproc-hash',
          'e2e-pipeline',
          '--min-quantile-samples',
          '1',
          '--budget-total',
          '0.05',
          '--spot-calib-count',
          '3',
          '--spot-p0',
          '0.9',
          '--min-tail',
          '1',
          '--flag-tail-prob',
          '0.5',
          '--alpha',
          '0.5',
          '--q',
          '0.9',
          '--calib-window',
          '10',
          '--decluster-r',
          '1',
          '--kofn',
          '1/1',
          '--H',
          '1.2',
          '--reestimate-every',
          '3',
          '--min-exceed',
          '1',
          '--pool-strategy',
          'per-user',
          '--xi-eps',
          '0.001',
          '--upper-cap-per-day',
          '10',
          '--lower-clip',
          '-5',
          '--seed',
          '777'
        ]);
        expect(anomFit.code).toBe(0);
        const anomFitPayload = parseJsonPayload(anomFit.stdout) as { stats: { base_column: string } };
        expect(anomFitPayload.stats.base_column).toBe('dt_sec');

        const anomScore = await runAnomCli([
          'score',
          '-i',
          anomInputPath,
          '-o',
          scoredCsvPath,
          '--stats',
          anomStatsPath,
          '--meta',
          anomMetaPath,
          '--audit',
          auditPath
        ]);
        expect(anomScore.code).toBe(0);
        expect(JSON.parse(anomScore.stdout) as { processedRows: number; flaggedRows: number }).toMatchObject({
          processedRows: measuredRecords.length
        });

        const vocabPath = join(tempDir, 'lstm', 'vocab.json');
        const cfgPath = join(tempDir, 'lstm', 'train_meta.json');
        const trainDir = join(tempDir, 'lstm', 'train');
        await mkdir(trainDir, { recursive: true });

        const lstmFit = await runDtLstmCli([
          'fit',
          '--in',
          anomInputPath,
          '--vocab-out',
          vocabPath,
          '--cfg-out',
          cfgPath,
          '--seed',
          '777'
        ]);
        expect(lstmFit.code).toBe(0);
        const lstmFitPayload = parseJsonPayload(lstmFit.stdout) as { event: string; vocab_path: string };
        expect(lstmFitPayload.event).toBe('fit.completed');

        const lstmTrain = await runDtLstmCli([
          'train',
          '--train',
          anomInputPath,
          '--vocab',
          vocabPath,
          '--numeric-cols',
          'dt_sec',
          '--delta-col',
          'dt_sec',
          '--epochs',
          '1',
          '--bs',
          '2',
          '--hidden',
          '8',
          '--emb-dim',
          '8',
          '--layers',
          '1',
          '--dropout',
          '0.0',
          '--lr',
          '5e-3',
          '--scheduler',
          'none',
          '--early',
          '1',
          '--time-head',
          'rmtpp',
          '--time-objective',
          'rmtpp',
          '--num-workers',
          '0',
          '--seed',
          '777',
          '--out',
          trainDir
        ]);
        expect(lstmTrain.code).toBe(0);
        const lstmTrainPayload = parseJsonPayload(lstmTrain.stdout) as {
          event: string;
          model_path: string;
          config_path: string;
        };
        expect(lstmTrainPayload.event).toBe('train.completed');

        const inferOutPath = join(tempDir, 'lstm', 'scores.csv');
        const inferAuditPath = join(tempDir, 'lstm', 'infer_audit.jsonl');
        const lstmInfer = await runDtLstmCli([
          'infer',
          '--in',
          anomInputPath,
          '--ckpt',
          lstmTrainPayload.model_path,
          '--out',
          inferOutPath,
          '--audit',
          inferAuditPath,
          '--topk',
          '1',
          '--seed',
          '777'
        ]);
        expect(lstmInfer.code).toBe(0);
        const lstmInferPayload = parseJsonPayload(lstmInfer.stdout) as { event: string; out_path: string };
        expect(lstmInferPayload.event).toBe('infer.completed');
        const inferCsv = await readFile(inferOutPath, 'utf8');
        expect(inferCsv.length).toBeGreaterThan(0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    180_000
  );
});
