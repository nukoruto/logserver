#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { stdin, stdout, stderr } from 'node:process';
import { format } from 'fast-csv';
import { parse as parseCsvSync } from 'csv-parse/sync';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';
import {
  DEFAULT_FEATURE_OPTIONS,
  loadLogRowsWithFeatures,
  type LogRow
} from './index.js';

const cliSchema = z.object({
  input: z.string().min(1).optional(),
  output: z.string().min(1).optional(),
  epsilon: z.number().min(0),
  epsilonT: z.number().min(0),
  clipMaxSeconds: z.number().positive(),
  robustZClip: z.number().positive(),
  validateSchema: z.boolean(),
  stats: z.string().min(1).optional(),
  pretty: z.boolean(),
  ignoreUids: z.string().min(1).optional()
});

function toNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('Invalid numeric argument');
  }
  return value;
}

async function loadIgnoreUids(path?: string): Promise<Set<string>> {
  if (!path) {
    return new Set();
  }
  const content = await readFile(path, 'utf8');
  const records = parseCsvSync(content, {
    skip_empty_lines: true,
    trim: true
  }) as unknown[];
  const values = new Set<string>();

  for (const record of records) {
    if (Array.isArray(record)) {
      for (const cell of record) {
        if (typeof cell === 'string' && cell.length > 0) {
          values.add(cell);
        }
      }
    } else if (typeof record === 'string' && record.length > 0) {
      values.add(record);
    }
  }

  return values;
}

function buildFilter(ignoreSet: Set<string> | undefined): ((row: LogRow) => boolean) | undefined {
  if (!ignoreSet || ignoreSet.size === 0) {
    return undefined;
  }
  return (row: LogRow): boolean => !ignoreSet.has(row.uid);
}

async function writeCsv(
  options: z.infer<typeof cliSchema>,
  featurePayload: Awaited<ReturnType<typeof loadLogRowsWithFeatures>>
): Promise<void> {
  const outputStream = options.output
    ? createWriteStream(options.output, { encoding: 'utf8' })
    : stdout;
  const csvStream = format({ headers: true });
  const pipePromise = pipeline(csvStream, outputStream);

  for (const row of featurePayload.rows) {
    csvStream.write({
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
      delta_log_burst: row.delta_log_burst ?? '',
      delta_time_label: row.delta_time_label,
      session_sequence: row.session_sequence,
      session_elapsed_seconds: row.session_elapsed_seconds ?? '',
      is_session_start: row.is_session_start ? 1 : 0
    });
  }

  csvStream.end();
  await pipePromise;

  if (options.stats) {
    const { parseStats, featureStats, options: normalized } = featurePayload;
    const summary = {
      options: {
        epsilon: normalized.epsilon,
        epsilon_t: normalized.epsilonT,
        clip_max_seconds: normalized.clipMaxSeconds,
        robust_scale_epsilon: normalized.robustScaleEpsilon,
        robust_z_clip: normalized.robustZClip,
        min_samples: normalized.minSamples,
        validate_schema: options.validateSchema,
        ignored_uid_count: featureStats.filteredOut,
        ignore_source: options.ignoreUids ?? null
      },
      parse: parseStats,
      features: featureStats
    };
    const json = JSON.stringify(summary, null, options.pretty ? 2 : 0);
    await writeFile(options.stats, json, 'utf8');
  }
}

async function main(): Promise<void> {
  const argv = yargs(hideBin(process.argv))
    .scriptName('dt-preproc')
    .usage('Usage: $0 [options]')
    .option('input', {
      alias: 'i',
      type: 'string',
      describe: 'Path to the input CSV file. If omitted, read from STDIN.'
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      describe: 'Path to the output CSV file. If omitted, write to STDOUT.'
    })
    .option('epsilon', {
      alias: 'e',
      type: 'number',
      default: DEFAULT_FEATURE_OPTIONS.epsilon,
      describe: 'Measurement resolution epsilon (seconds). Values below are snapped to zero.'
    })
    .option('epsilon-t', {
      alias: 't',
      type: 'number',
      default: DEFAULT_FEATURE_OPTIONS.epsilonT,
      describe: 'Timing uncertainty epsilon_t (seconds). Values below are marked as unknown.'
    })
    .option('clip-max', {
      alias: 'c',
      type: 'number',
      default: DEFAULT_FEATURE_OPTIONS.clipMaxSeconds,
      describe: 'Upper bound for Δt clipping (seconds).'
    })
    .option('robust-z-clip', {
      type: 'number',
      default: DEFAULT_FEATURE_OPTIONS.robustZClip,
      describe: 'Symmetric clipping limit for robust z-scores.'
    })
    .option('stats', {
      type: 'string',
      describe: 'Optional path to write feature statistics JSON.'
    })
    .option('pretty', {
      type: 'boolean',
      default: false,
      describe: 'Pretty-print the statistics JSON.'
    })
    .option('ignore-uids', {
      type: 'string',
      describe: 'CSV file listing uid values to exclude from feature computation.'
    })
    .option('validate-schema', {
      type: 'boolean',
      default: true,
      describe: 'Enable CSV schema validation using @logserver/csv-schema.'
    })
    .help()
    .strict()
    .parseSync();

  const parsed = cliSchema.parse({
    input: argv.input,
    output: argv.output,
    epsilon: toNumber(argv.epsilon),
    epsilonT: toNumber(argv.epsilonT),
    clipMaxSeconds: toNumber(argv.clipMax),
    robustZClip: toNumber(argv.robustZClip),
    validateSchema: argv.validateSchema,
    stats: argv.stats,
    pretty: argv.pretty,
    ignoreUids: argv.ignoreUids
  });

  const ignoreSet = await loadIgnoreUids(parsed.ignoreUids);
  const source = parsed.input ? parsed.input : stdin;
  if (!parsed.input) {
    stdin.setEncoding('utf8');
  }

  const featurePayload = await loadLogRowsWithFeatures(source, {
    epsilon: parsed.epsilon,
    epsilonT: parsed.epsilonT,
    clipMaxSeconds: parsed.clipMaxSeconds,
    robustZClip: parsed.robustZClip,
    validateSchema: parsed.validateSchema,
    filter: buildFilter(ignoreSet)
  });

  await writeCsv(parsed, featurePayload);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`dt-preproc: ${message}\n`);
  process.exitCode = 1;
});
