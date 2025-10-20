import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parse as parseCsvSync } from 'csv-parse/sync';
import { expect, test } from 'vitest';

import { parseCsv } from '@logserver/csv-schema';

import {
  DEFAULT_FEATURE_OPTIONS,
  StreamingFeatureTransformer,
  attachTemplate,
  thawFittedStats,
  type LogRowWithFeats,
  type SerializedPreprocStats
} from '../src/index.js';

const execFileAsync = promisify(execFile);
const packageRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const cliPath = path.join(packageRoot, 'src', 'cli.ts');

function fixturePath(name: string): string {
  return path.join(packageRoot, 'test', 'fixtures', name);
}

function normalizeNumber(value: number | null): number | null {
  if (value === null || Number.isNaN(value)) {
    return null;
  }
  return Math.round(value * 1e9) / 1e9;
}

function normalizeFeatureRow(row: LogRowWithFeats) {
  return {
    timestamp_epoch_seconds: normalizeNumber(row.timestamp_epoch_seconds),
    uid: row.uid,
    session_id: row.session_id,
    row_index: row.row_index,
    delta_seconds: normalizeNumber(row.delta_seconds),
    delta_clipped_seconds: normalizeNumber(row.delta_clipped_seconds),
    delta_robust_z: normalizeNumber(row.delta_robust_z),
    delta_z_deseas_clipped: normalizeNumber(row.delta_z_deseas_clipped),
    delta_log_burst: normalizeNumber(row.delta_log_burst),
    delta_quantile_0_25: normalizeNumber((row as Record<string, number | null>)['delta_quantile_0_25'] ?? null),
    delta_quantile_0_5: normalizeNumber((row as Record<string, number | null>)['delta_quantile_0_5'] ?? null),
    delta_quantile_0_75: normalizeNumber((row as Record<string, number | null>)['delta_quantile_0_75'] ?? null),
    delta_m25: normalizeNumber(row.delta_m25 ?? null),
    delta_m50: normalizeNumber(row.delta_m50 ?? null),
    delta_m75: normalizeNumber(row.delta_m75 ?? null),
    delta_time_label: row.delta_time_label,
    session_sequence: row.session_sequence,
    session_elapsed_seconds: normalizeNumber(row.session_elapsed_seconds),
    is_session_start: row.is_session_start
  };
}

function parseNullableNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric value but received '${value}'`);
  }
  return normalizeNumber(parsed);
}

function normalizeCsvRow(row: Record<string, string>) {
  return {
    timestamp_epoch_seconds: normalizeNumber(Number(row.timestamp_epoch_seconds)),
    uid: row.uid,
    session_id: row.session_id,
    row_index: Number(row.row_index),
    delta_seconds: parseNullableNumber(row.delta_seconds),
    delta_clipped_seconds: parseNullableNumber(row.delta_clipped_seconds),
    delta_robust_z: parseNullableNumber(row.delta_robust_z),
    delta_z_deseas_clipped: parseNullableNumber(row.delta_z_deseas_clipped),
    delta_log_burst: parseNullableNumber(row.delta_log_burst),
    delta_quantile_0_25: parseNullableNumber(row.delta_quantile_0_25),
    delta_quantile_0_5: parseNullableNumber(row.delta_quantile_0_5),
    delta_quantile_0_75: parseNullableNumber(row.delta_quantile_0_75),
    delta_m25: parseNullableNumber(row.delta_m25),
    delta_m50: parseNullableNumber(row.delta_m50),
    delta_m75: parseNullableNumber(row.delta_m75),
    delta_time_label: row.delta_time_label,
    session_sequence: Number(row.session_sequence),
    session_elapsed_seconds: parseNullableNumber(row.session_elapsed_seconds),
    is_session_start: row.is_session_start === '1'
  };
}

async function runCli(args: string[]): Promise<void> {
  await execFileAsync(process.execPath, ['--loader', 'ts-node/esm', cliPath, ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      TS_NODE_PROJECT: path.join(packageRoot, 'tsconfig.json')
    }
  });
}

type StatsPayload = SerializedPreprocStats & {
  version: number;
  options: NonNullable<SerializedPreprocStats['options']>;
};

async function computeRowsWithStats(stats: StatsPayload, inputPath: string): Promise<LogRowWithFeats[]> {
  const options = stats.options ?? {
    measurement_epsilon: DEFAULT_FEATURE_OPTIONS.epsilon,
    epsilon_t: DEFAULT_FEATURE_OPTIONS.epsilonT,
    clip_max_seconds: DEFAULT_FEATURE_OPTIONS.clipMaxSeconds,
    robust_z_clip: DEFAULT_FEATURE_OPTIONS.robustZClip,
    min_samples: DEFAULT_FEATURE_OPTIONS.minSamples,
    quantile_window: DEFAULT_FEATURE_OPTIONS.quantileWindow,
    quantiles: Array.from(DEFAULT_FEATURE_OPTIONS.quantiles)
  };

  const transformer = new StreamingFeatureTransformer({
    fitted: thawFittedStats(stats),
    grouping: (stats.grouping ?? 'uid') as 'uid' | 'uid_session',
    epsilon: stats.epsilon ?? options.measurement_epsilon,
    epsilonT: options.epsilon_t ?? DEFAULT_FEATURE_OPTIONS.epsilonT,
    clipMaxSeconds: options.clip_max_seconds ?? DEFAULT_FEATURE_OPTIONS.clipMaxSeconds,
    robustZClip: options.robust_z_clip ?? DEFAULT_FEATURE_OPTIONS.robustZClip,
    minSamples: options.min_samples ?? DEFAULT_FEATURE_OPTIONS.minSamples,
    quantileWindow: options.quantile_window ?? DEFAULT_FEATURE_OPTIONS.quantileWindow,
    quantiles: options.quantiles ?? Array.from(DEFAULT_FEATURE_OPTIONS.quantiles)
  });

  const rows: LogRowWithFeats[] = [];
  const parser = parseCsv(inputPath, { validateSchema: true });
  for await (const raw of parser) {
    rows.push(transformer.process(attachTemplate(raw)));
  }
  return rows;
}

test('dt-preproc CLI fits and transforms CSV end-to-end', async () => {
  const inputCsv = fixturePath('golden_input.csv');
  const tempDir = await mkdtemp(path.join(tmpdir(), 'dt-preproc-cli-'));
  const statsPath = path.join(tempDir, 'stats.json');
  const metaPath = path.join(tempDir, 'meta.json');
  const outputCsv = path.join(tempDir, 'transformed.csv');
  const manifestPath = path.join(tempDir, 'train.txt');
  await fs.writeFile(manifestPath, `${inputCsv}\n`, 'utf8');

  await runCli([
    'fit',
    '--in',
    `@${manifestPath}`,
    '--out',
    statsPath,
    '--meta',
    metaPath,
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
    '2',
    '--window',
    '10',
    '--quantiles',
    '0.25,0.5,0.75',
    '--fold-id',
    'fold0'
  ]);

  await runCli([
    'transform',
    '--in',
    inputCsv,
    '--stats',
    statsPath,
    '--out',
    outputCsv,
    '--validate-schema',
    '--fold-id',
    'fold0',
    '--fit-manifest',
    `@${manifestPath}`
  ]);

  const statsPayload = JSON.parse(await fs.readFile(statsPath, 'utf8')) as StatsPayload;
  expect(statsPayload.version).toBe(1);
  expect(statsPayload.grouping).toBe('uid');
  expect(statsPayload.epsilon).toBeCloseTo(statsPayload.options.measurement_epsilon, 9);
  expect(statsPayload.options).toEqual({
    measurement_epsilon: statsPayload.options.measurement_epsilon,
    epsilon_t: 0.05,
    clip_max_seconds: 300,
    robust_z_clip: 5,
    min_samples: 2,
    quantile_window: 10,
    quantiles: [0.25, 0.5, 0.75]
  });
  expect(statsPayload.fold_id).toBe('fold0');
  expect(statsPayload.source_manifest_hash).toBeDefined();
  expect(statsPayload.sources).toEqual([
    {
      path: 'test/fixtures/golden_input.csv',
      path_hash: expect.any(String),
      row_count: 13,
      row_hash: expect.any(String)
    }
  ]);
  expect(statsPayload.parse).toEqual({
    total_rows: 13,
    valid_rows: 13,
    invalid_rows: 0,
    invalid_reasons: {},
    schema_validated: true
  });
  const manifestHash = createHash('sha256');
  manifestHash.update('test/fixtures/golden_input.csv\n');
  expect(statsPayload.source_manifest_hash).toBe(manifestHash.digest('hex'));

  const metaPayload = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
    algo_ver: string;
    epsilon: string;
    epsilon_value: number;
  };
  expect(metaPayload.algo_ver).toBe('5.0-spec');
  expect(metaPayload.epsilon).toBe('min_half');
  expect(metaPayload.epsilon_value).toBeCloseTo(statsPayload.options.measurement_epsilon, 9);

  const csvContent = await fs.readFile(outputCsv, 'utf8');
  const csvRecords = parseCsvSync(csvContent, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  const actualRows = csvRecords.map(normalizeCsvRow);

  const expectedRows = (await computeRowsWithStats(statsPayload, inputCsv)).map(normalizeFeatureRow);

  expect(actualRows).toEqual(expectedRows);
}, 30000);

test('transform requires explicit fold confirmation', async () => {
  const inputCsv = fixturePath('golden_input.csv');
  const tempDir = await mkdtemp(path.join(tmpdir(), 'dt-preproc-fold-'));
  const statsPath = path.join(tempDir, 'stats.json');
  const outputCsv = path.join(tempDir, 'transformed.csv');
  const manifestPath = path.join(tempDir, 'train.txt');
  await fs.writeFile(manifestPath, `${inputCsv}\n`, 'utf8');

  await runCli([
    'fit',
    '--in',
    `@${manifestPath}`,
    '--out',
    statsPath,
    '--grouping',
    'uid',
    '--fold-id',
    'fold1'
  ]);

  await expect(
    runCli([
      'transform',
      '--in',
      inputCsv,
      '--stats',
      statsPath,
      '--out',
      outputCsv
    ])
  ).rejects.toThrow(/Provide '--fold-id fold1'/);
}, 10000);

test('transform rejects mismatched training manifest', async () => {
  const inputCsv = fixturePath('golden_input.csv');
  const tempDir = await mkdtemp(path.join(tmpdir(), 'dt-preproc-mismatch-'));
  const statsPath = path.join(tempDir, 'stats.json');
  const outputCsv = path.join(tempDir, 'transformed.csv');
  const manifestPath = path.join(tempDir, 'train.txt');
  await fs.writeFile(manifestPath, `${inputCsv}\n`, 'utf8');

  await runCli([
    'fit',
    '--in',
    `@${manifestPath}`,
    '--out',
    statsPath,
    '--grouping',
    'uid',
    '--fold-id',
    'fold2'
  ]);

  const wrongManifest = path.join(tempDir, 'wrong.txt');
  const alternateCsv = fixturePath('pipeline_small.csv');
  await fs.writeFile(wrongManifest, `${alternateCsv}\n`, 'utf8');

  await expect(
    runCli([
      'transform',
      '--in',
      inputCsv,
      '--stats',
      statsPath,
      '--out',
      outputCsv,
      '--fold-id',
      'fold2',
      '--fit-manifest',
      `@${wrongManifest}`
    ])
  ).rejects.toThrow(/Training manifest mismatch/);
}, 10000);
