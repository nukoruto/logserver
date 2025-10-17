#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { stderr } from 'node:process';
import { format } from 'fast-csv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';
import {
  DEFAULT_FEATURE_OPTIONS,
  StreamingFeatureTransformer,
  fitRobustStats,
  freezeFittedStats,
  thawFittedStats,
  type LogRow,
  type LogRowWithFeats,
  type SerializedPreprocOptions,
  type SerializedPreprocStats,
  type StreamingTransformerOptions
} from './index.js';
import { parseCsv, type CsvParseStats } from '@logserver/csv-schema';

interface AggregateParseStats {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  invalidReasons: Map<string, number>;
  schemaValidated: boolean;
}

const FIT_SCHEMA = z.object({
  inputs: z.array(z.string().min(1)).nonempty(),
  grouping: z.enum(['uid', 'uid_session']),
  epsilonT: z.number().min(0),
  clipMaxSeconds: z.number().positive(),
  robustZClip: z.number().positive(),
  minSamples: z.number().positive(),
  window: z.number().min(0),
  quantiles: z.array(z.number()).optional(),
  out: z.string().min(1),
  meta: z.string().min(1).optional(),
  pretty: z.boolean()
});

const TRANSFORM_SCHEMA = z.object({
  inputs: z.array(z.string().min(1)).nonempty(),
  stats: z.string().min(1),
  output: z.string().min(1),
  epsilonT: z.number().min(0).optional(),
  clipMaxSeconds: z.number().positive().optional(),
  robustZClip: z.number().positive().optional(),
  window: z.number().min(0).optional(),
  quantiles: z.array(z.number()).optional(),
  validateSchema: z.boolean(),
  pretty: z.boolean()
});

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new TypeError('Invalid numeric argument');
}

function parseQuantileValues(value: unknown): number[] {
  if (value === undefined || value === null) {
    return [];
  }
  const bucket: number[] = [];
  const rawItems = Array.isArray(value) ? value : [value];
  for (const item of rawItems) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      bucket.push(item);
      continue;
    }
    if (typeof item === 'string') {
      const pieces = item.split(',');
      for (const piece of pieces) {
        const trimmed = piece.trim();
        if (!trimmed) {
          continue;
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) {
          throw new TypeError(`Invalid quantile value '${trimmed}'`);
        }
        bucket.push(parsed);
      }
      continue;
    }
    throw new TypeError('Invalid quantile argument');
  }
  return bucket;
}

function resolveQuantileArgs(value: unknown, fallback: readonly number[]): number[] {
  const parsed = parseQuantileValues(value);
  if (parsed.length === 0) {
    return [...fallback];
  }
  return parsed;
}

function createAggregateParseStats(): AggregateParseStats {
  return {
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    invalidReasons: new Map<string, number>(),
    schemaValidated: false
  };
}

function mergeParseStats(target: AggregateParseStats, source: CsvParseStats): void {
  target.totalRows += source.totalRows;
  target.validRows += source.validRows;
  target.invalidRows += source.invalidRows;
  target.schemaValidated = target.schemaValidated || source.schemaValidated;
  for (const [reason, count] of Object.entries(source.invalidReasons)) {
    const current = target.invalidReasons.get(reason) ?? 0;
    target.invalidReasons.set(reason, current + count);
  }
}

function hasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|\[\]\\]/g, '\\$&');
  const replaced = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(`^${replaced}$`);
}

async function expandInputPatterns(patterns: readonly string[]): Promise<string[]> {
  const results: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) {
      continue;
    }
    if (!hasGlob(pattern)) {
      await stat(pattern);
      results.push(pattern);
      continue;
    }
    const directory = dirname(pattern) || '.';
    const base = basename(pattern);
    const regex = globToRegExp(base);
    const entries = await readdir(directory, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && regex.test(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort();
    if (matches.length === 0) {
      throw new Error(`Pattern '${pattern}' did not match any files`);
    }
    results.push(...matches);
  }
  return results;
}

async function ensureParent(path: string): Promise<void> {
  const parent = dirname(path);
  if (!parent || parent === '.' || parent === path) {
    return;
  }
  await mkdir(parent, { recursive: true });
}

function resolveQuantileColumns(
  fields: ReadonlyArray<{ field: string; alias?: string | undefined }>
): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const descriptor of fields) {
    if (descriptor.field && !seen.has(descriptor.field)) {
      columns.push(descriptor.field);
      seen.add(descriptor.field);
    }
    if (descriptor.alias && !seen.has(descriptor.alias)) {
      columns.push(descriptor.alias);
      seen.add(descriptor.alias);
    }
  }
  return columns;
}

function toCsvRecord(row: LogRowWithFeats, quantileColumns: readonly string[]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    timestamp_utc: row.timestamp_utc,
    timestamp_epoch_seconds: row.timestamp_epoch_seconds,
    uid: row.uid,
    session_id: row.session_id,
    method: row.method,
    path: row.path,
    referer: row.referer,
    user_agent: row.user_agent,
    ip: row.ip,
    op_category: row.op_category,
    row_index: row.row_index,
    delta_seconds: row.delta_seconds ?? '',
    delta_clipped_seconds: row.delta_clipped_seconds ?? '',
    delta_robust_z: row.delta_robust_z ?? '',
    delta_z_deseas_clipped: row.delta_z_deseas_clipped ?? '',
    delta_log_burst: row.delta_log_burst ?? '',
    delta_time_label: row.delta_time_label,
    session_sequence: row.session_sequence,
    session_elapsed_seconds: row.session_elapsed_seconds ?? '',
    is_session_start: row.is_session_start ? 1 : 0
  };

  for (const column of quantileColumns) {
    const dynamicRow = row as unknown as Record<string, unknown>;
    const value = dynamicRow[column];
    base[column] = value ?? '';
  }

  return base;
}

function detectYaml(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  return path.endsWith('.yaml') || path.endsWith('.yml');
}

function serializeYaml(value: unknown, indent = 0): string {
  const indentation = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indentation}[]`;
    }
    return value
      .map((item) => {
        const serialized = serializeYaml(item, indent + 1);
        if (serialized.includes('\n')) {
          return `${indentation}-\n${serialized}`;
        }
        return `${indentation}- ${serialized.trim()}`;
      })
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return `${indentation}{}`;
    }
    return entries
      .map(([key, val]) => {
        const serialized = serializeYaml(val, indent + 1);
        if (serialized.includes('\n')) {
          return `${indentation}${key}:\n${serialized}`;
        }
        return `${indentation}${key}: ${serialized.trim()}`;
      })
      .join('\n');
  }
  if (typeof value === 'string') {
    if (value === '') {
      return `${indentation}''`;
    }
    if (/^[A-Za-z0-9_.-]+$/.test(value)) {
      return `${indentation}${value}`;
    }
    return `${indentation}${JSON.stringify(value)}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${indentation}${String(value)}`;
  }
  return `${indentation}null`;
}

async function writeMeta(path: string | undefined, epsilonValue: number, pretty: boolean): Promise<void> {
  if (!path) {
    return;
  }
  await ensureParent(path);
  const payload = {
    algo_ver: '5.0-spec',
    epsilon: 'min_half',
    epsilon_value: epsilonValue
  };
  const content = detectYaml(path)
    ? `${serializeYaml(payload)}\n`
    : `${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`;
  await writeFile(path, content, 'utf8');
}

function buildOptionsPayload(
  parsed: z.infer<typeof FIT_SCHEMA>,
  measurementEpsilon: number
): SerializedPreprocOptions {
  const quantileList = parsed.quantiles && parsed.quantiles.length > 0
    ? Array.from(parsed.quantiles)
    : [...DEFAULT_FEATURE_OPTIONS.quantiles];
  return {
    measurement_epsilon: measurementEpsilon,
    epsilon_t: parsed.epsilonT,
    clip_max_seconds: parsed.clipMaxSeconds,
    robust_z_clip: parsed.robustZClip,
    min_samples: Math.max(1, Math.floor(parsed.minSamples)),
    quantile_window: Math.max(0, Math.floor(parsed.window)),
    quantiles: quantileList
  };
}

function deriveTransformOptions(
  parsed: z.infer<typeof TRANSFORM_SCHEMA>,
  stats: SerializedPreprocStats
): StreamingTransformerOptions {
  const thawed = thawFittedStats(stats);
  const stored = stats.options;
  const grouping = stats.grouping ?? 'uid';
  const storedWindow = stored?.quantile_window;
  const storedQuantiles = stored?.quantiles;
  const effectiveWindow = parsed.window !== undefined
    ? Math.max(0, Math.floor(parsed.window))
    : Number.isFinite(storedWindow)
    ? Math.max(0, Math.floor(storedWindow as number))
    : DEFAULT_FEATURE_OPTIONS.quantileWindow;
  const effectiveQuantiles = parsed.quantiles && parsed.quantiles.length > 0
    ? Array.from(parsed.quantiles)
    : storedQuantiles && storedQuantiles.length > 0
    ? Array.from(storedQuantiles)
    : [...DEFAULT_FEATURE_OPTIONS.quantiles];
  return {
    fitted: thawed,
    grouping,
    epsilon: thawed.epsilon,
    epsilonT: parsed.epsilonT ?? stored?.epsilon_t ?? DEFAULT_FEATURE_OPTIONS.epsilonT,
    clipMaxSeconds: parsed.clipMaxSeconds ?? stored?.clip_max_seconds ?? DEFAULT_FEATURE_OPTIONS.clipMaxSeconds,
    robustZClip: parsed.robustZClip ?? stored?.robust_z_clip ?? DEFAULT_FEATURE_OPTIONS.robustZClip,
    minSamples: stored?.min_samples ?? DEFAULT_FEATURE_OPTIONS.minSamples,
    quantileWindow: effectiveWindow,
    quantiles: effectiveQuantiles
  };
}

function buildStatsPayload(
  frozen: SerializedPreprocStats,
  options: SerializedPreprocOptions,
  grouping: 'uid' | 'uid_session'
): SerializedPreprocStats {
  return {
    ...frozen,
    version: 1,
    grouping,
    options
  };
}

async function resolveOutputPaths(inputs: readonly string[], spec: string): Promise<string[]> {
  if (inputs.length === 0) {
    throw new Error('No input files provided');
  }
  const patternIndex = spec.indexOf('*');
  if (patternIndex !== -1) {
    if (spec.indexOf('*', patternIndex + 1) !== -1) {
      throw new Error('Output pattern supports at most one "*" character');
    }
    const prefix = spec.slice(0, patternIndex);
    const suffix = spec.slice(patternIndex + 1);
    return inputs.map((input) => prefix + basename(input) + suffix);
  }
  try {
    const info = await stat(spec);
    if (info.isDirectory()) {
      return inputs.map((input) => join(spec, basename(input)));
    }
    if (inputs.length === 1) {
      return [spec];
    }
    throw new Error('Output path must be a directory or pattern when multiple inputs are provided');
  } catch {
    if (inputs.length === 1) {
      return [spec];
    }
    await mkdir(spec, { recursive: true });
    return inputs.map((input) => join(spec, basename(input)));
  }
}

async function runFit(argv: unknown): Promise<void> {
  const parsed = FIT_SCHEMA.parse(argv);
  const inputPaths = await expandInputPatterns(parsed.inputs);
  if (inputPaths.length === 0) {
    throw new Error('No input files matched');
  }

  const aggregate = createAggregateParseStats();
  const allRows: LogRow[] = [];

  for (const path of inputPaths) {
    const parser = parseCsv(path, { validateSchema: true });
    for await (const row of parser) {
      allRows.push(row);
    }
    mergeParseStats(aggregate, parser.getStats());
  }

  const fitted = fitRobustStats(allRows, {
    epsilon_t: parsed.epsilonT,
    grouping: parsed.grouping,
    min_samples: parsed.minSamples
  });

  const options = buildOptionsPayload(parsed, fitted.epsilon);

  const frozen = freezeFittedStats(fitted) as SerializedPreprocStats;
  const payload = buildStatsPayload(frozen, options, parsed.grouping);

  await ensureParent(parsed.out);
  const statsJson = `${JSON.stringify(payload, null, parsed.pretty ? 2 : 0)}\n`;
  await writeFile(parsed.out, statsJson, 'utf8');

  await writeMeta(parsed.meta, fitted.epsilon, parsed.pretty);
}

async function runTransform(argv: unknown): Promise<void> {
  const parsed = TRANSFORM_SCHEMA.parse(argv);
  const inputPaths = await expandInputPatterns(parsed.inputs);
  if (inputPaths.length === 0) {
    throw new Error('No input files matched');
  }

  const statsText = await readFile(parsed.stats, 'utf8');
  const statsPayload = JSON.parse(statsText) as SerializedPreprocStats;
  const transformerOptions = deriveTransformOptions(parsed, statsPayload);
  const transformer = new StreamingFeatureTransformer(transformerOptions);
  const quantileColumns = resolveQuantileColumns(transformer.getOptions().quantileFields);

  const outputPaths = await resolveOutputPaths(inputPaths, parsed.output);
  if (outputPaths.length !== inputPaths.length) {
    throw new Error('Mismatch between inputs and resolved outputs');
  }

  for (let index = 0; index < inputPaths.length; index += 1) {
    const input = inputPaths[index];
    const output = outputPaths[index];

    await ensureParent(output);

    const parser = parseCsv(input, { validateSchema: parsed.validateSchema });
    const csvStream = format({ headers: true });
    const outputStream = createWriteStream(output, { encoding: 'utf8' });
    const pipePromise = pipeline(csvStream, outputStream);

    for await (const row of parser) {
      const featureRow = transformer.process(row);
      csvStream.write(toCsvRecord(featureRow, quantileColumns));
    }

    csvStream.end();
    await pipePromise;
  }
}

async function main(): Promise<void> {
  const cli = yargs(hideBin(process.argv))
    .scriptName('dt-preproc')
    .command(
      'fit',
      'Fit Δt robust statistics from training CSV files',
      (cmd) =>
        cmd
          .option('in', {
            type: 'array',
            demandOption: true,
            describe: 'Input CSV files (supports shell glob expansion)',
            alias: ['input']
          })
          .option('grouping', {
            type: 'string',
            choices: ['uid', 'uid_session'] as const,
            default: 'uid',
            describe: 'Grouping strategy for robust statistics'
          })
          .option('epsilon-t', {
            type: 'number',
            default: DEFAULT_FEATURE_OPTIONS.epsilonT,
            describe: 'Timing uncertainty epsilon_t (seconds)'
          })
          .option('clip-max', {
            type: 'number',
            default: DEFAULT_FEATURE_OPTIONS.clipMaxSeconds,
            describe: 'Upper bound for Δt clipping (seconds)'
          })
          .option('robust-z-clip', {
            type: 'number',
            default: DEFAULT_FEATURE_OPTIONS.robustZClip,
            describe: 'Symmetric clipping limit for robust z-scores'
          })
          .option('min-samples', {
            type: 'number',
            default: DEFAULT_FEATURE_OPTIONS.minSamples,
            describe: 'Minimum samples required for per-group robust stats'
          })
          .option('window', {
            type: 'number',
            default: DEFAULT_FEATURE_OPTIONS.quantileWindow,
            describe: 'Rolling window size for Δt quantile features'
          })
          .option('quantiles', {
            type: 'string',
            default: DEFAULT_FEATURE_OPTIONS.quantiles.join(','),
            describe: 'Comma-separated quantile probabilities (0-1) for Δt features'
          })
          .option('out', {
            type: 'string',
            demandOption: true,
            describe: 'Output path for serialized statistics JSON'
          })
          .option('meta', {
            type: 'string',
            describe: 'Optional metadata path (supports JSON or YAML)'
          })
          .option('pretty', {
            type: 'boolean',
            default: false,
            describe: 'Pretty-print JSON outputs'
          }),
      async (argv) => {
        const windowSize = Math.max(
          0,
          Math.floor(toNumber(argv.window ?? DEFAULT_FEATURE_OPTIONS.quantileWindow))
        );
        const quantiles = resolveQuantileArgs(argv.quantiles, DEFAULT_FEATURE_OPTIONS.quantiles);
        const args = {
          inputs: (argv.in as unknown[]).map(String),
          grouping: argv.grouping as 'uid' | 'uid_session',
          epsilonT: toNumber(argv.epsilonT ?? argv['epsilon-t']),
          clipMaxSeconds: toNumber(argv.clipMax ?? argv['clip-max']),
          robustZClip: toNumber(argv.robustZClip ?? argv['robust-z-clip']),
          minSamples: toNumber(argv.minSamples ?? argv['min-samples']),
          window: windowSize,
          quantiles,
          out: String(argv.out),
          meta: typeof argv.meta === 'string' ? argv.meta : undefined,
          pretty: Boolean(argv.pretty)
        };
        await runFit(args);
      }
    )
    .command(
      'transform',
      'Apply fitted statistics to CSV files and append Δt features',
      (cmd) =>
        cmd
          .option('in', {
            type: 'array',
            demandOption: true,
            describe: 'Input CSV files (supports shell glob expansion)',
            alias: ['input']
          })
          .option('stats', {
            type: 'string',
            demandOption: true,
            describe: 'Path to serialized statistics JSON produced by the fit command'
          })
          .option('out', {
            type: 'string',
            demandOption: true,
            describe: 'Output file, directory, or pattern (use * to substitute file names)'
          })
          .option('epsilon-t', {
            type: 'number',
            describe: 'Override timing uncertainty epsilon_t (seconds)'
          })
          .option('clip-max', {
            type: 'number',
            describe: 'Override Δt clipping upper bound (seconds)'
          })
          .option('robust-z-clip', {
            type: 'number',
            describe: 'Override robust z-score clipping limit'
          })
          .option('window', {
            type: 'number',
            describe: 'Override rolling window size for Δt quantile features'
          })
          .option('quantiles', {
            type: 'string',
            describe: 'Override Δt quantile probabilities (comma separated)'
          })
          .option('validate-schema', {
            type: 'boolean',
            default: true,
            describe: 'Enable CSV schema validation'
          })
          .option('pretty', {
            type: 'boolean',
            default: false,
            describe: 'Unused placeholder for interface consistency'
          }),
      async (argv) => {
        const windowOverride =
          argv.window !== undefined ? Math.max(0, Math.floor(toNumber(argv.window))) : undefined;
        const quantileOverride =
          argv.quantiles !== undefined
            ? resolveQuantileArgs(argv.quantiles, DEFAULT_FEATURE_OPTIONS.quantiles)
            : undefined;
        const args = {
          inputs: (argv.in as unknown[]).map(String),
          stats: String(argv.stats),
          output: String(argv.out),
          epsilonT: argv.epsilonT !== undefined ? toNumber(argv.epsilonT) : argv['epsilon-t'] !== undefined ? toNumber(argv['epsilon-t']) : undefined,
          clipMaxSeconds: argv.clipMax !== undefined ? toNumber(argv.clipMax) : argv['clip-max'] !== undefined ? toNumber(argv['clip-max']) : undefined,
          robustZClip: argv.robustZClip !== undefined ? toNumber(argv.robustZClip) : argv['robust-z-clip'] !== undefined ? toNumber(argv['robust-z-clip']) : undefined,
          window: windowOverride,
          quantiles: quantileOverride,
          validateSchema: argv.validateSchema !== undefined ? Boolean(argv.validateSchema) : true,
          pretty: Boolean(argv.pretty)
        };
        await runTransform(args);
      }
    )
    .demandCommand(1)
    .strict()
    .help();

  await cli.parseAsync();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`dt-preproc: ${message}\n`);
  if (error instanceof Error && error.stack) {
    stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
