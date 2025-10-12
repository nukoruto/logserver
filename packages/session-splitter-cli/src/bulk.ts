#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsPromises } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';

import { Command } from 'commander';

import {
  AugmentedRow,
  SessionSplitOptions,
  algoVersion,
  deriveDatasetKey,
  estimateThresholdsWithMeta,
  splitSessions,
  writeMeta,
  SessionSplitterError,
  ThresholdMetaInput
} from '@logserver/session-splitter';

const HKDF_INFO_BASE64 = Buffer.from('sid', 'utf8').toString('base64');
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

interface BulkCliOptions {
  in: string;
  out: string;
  meta: string;
  epsilon?: number;
  k?: number;
  scanStep?: number;
  minEvents?: number;
  kid?: string;
  algo?: string;
  idleTimeout?: number;
  timestampColumn?: string;
  userColumn?: string;
  sessionColumn?: string;
  concurrency?: number;
  shardDir?: string;
}

interface AugmentedColumnSpec {
  header: string;
  select: (row: AugmentedRow) => string | number | null | undefined;
}

class ProgressBar {
  private readonly total: number;
  private readonly width: number;
  private lastValue = 0;
  private lastRender = '';
  private lastTimestamp = 0;
  private lastLength = 0;

  constructor(total: number, width = 30) {
    this.total = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
    this.width = width;
  }

  update(current: number): void {
    if (this.total <= 0) {
      this.renderMessage(`Processed ${current} rows`);
      this.lastValue = current;
      return;
    }
    const now = Date.now();
    if (current < this.total && current === this.lastValue && now - this.lastTimestamp < 200) {
      return;
    }
    this.lastValue = current;
    this.lastTimestamp = now;
    const clamped = Math.min(Math.max(current, 0), this.total);
    const ratio = clamped / this.total;
    const filled = Math.round(this.width * ratio);
    const empty = this.width - filled;
    const bar = `[${'#'.repeat(filled)}${'.'.repeat(empty)}]`;
    const percent = (ratio * 100).toFixed(1).padStart(6, ' ');
    const line = `${bar} ${percent}% (${clamped}/${this.total})`;
    this.renderMessage(line);
  }

  finish(finalValue?: number): void {
    if (this.total <= 0) {
      const value = finalValue ?? this.lastValue;
      this.renderMessage(`Processed ${value} rows`);
      process.stderr.write('\n');
      return;
    }
    this.update(this.total);
    process.stderr.write('\n');
  }

  private renderMessage(message: string): void {
    if (message === this.lastRender) {
      return;
    }
    this.lastRender = message;
    const padding = this.lastLength > message.length ? ' '.repeat(this.lastLength - message.length) : '';
    process.stderr.write(`\r${message}${padding}`);
    this.lastLength = message.length;
  }
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = typeof value === 'string' ? value : String(value);
  if (/["\n,\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function ensureInputExists(filePath: string): Promise<void> {
  try {
    await fsPromises.access(filePath);
  } catch (error) {
    throw new SessionSplitterError(`Input file not found: ${filePath}`, error);
  }
}

async function countCsvRecords(filePath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let index = -1;
      while ((index = text.indexOf('\n', index + 1)) !== -1) {
        count += 1;
      }
    });
    stream.on('error', (error: unknown) => {
      reject(error);
    });
    stream.on('end', () => {
      const records = count > 0 ? Math.max(count - 1, 0) : 0;
      resolve(records);
    });
  });
}

function toSortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries(Array.from(entries).sort(([a], [b]) => a.localeCompare(b)));
}

function createThresholdIterable(
  deltaMap: Map<string, number[]>,
  idleTimeout: number
): Iterable<AugmentedRow> {
  function* generator(): Generator<AugmentedRow> {
    for (const [uid, deltas] of deltaMap.entries()) {
      for (const delta of deltas) {
        yield {
          algo_ver: algoVersion,
          uid,
          generatedSessionId: '',
          sessionSequence: 0,
          sessionIndex: 0,
          timestampUtc: '',
          deltaSeconds: delta,
          idleTimeoutSeconds: idleTimeout,
          splitReason: 'continuous',
          original: {}
        };
      }
    }
  }
  return { [Symbol.iterator]: generator };
}

async function run(cliOptions: BulkCliOptions): Promise<void> {
  await ensureInputExists(cliOptions.in);

  const epsilon = cliOptions.epsilon;
  if (!Number.isFinite(epsilon) || epsilon! <= 0) {
    throw new SessionSplitterError('--epsilon must be a positive number');
  }
  const kneeSigma = cliOptions.k;
  if (!Number.isFinite(kneeSigma) || kneeSigma! < 0) {
    throw new SessionSplitterError('--k must be zero or a positive number');
  }
  const scanStep = cliOptions.scanStep;
  if (!Number.isFinite(scanStep) || scanStep! <= 0) {
    throw new SessionSplitterError('--scan-step must be a positive number');
  }
  const minEvents = cliOptions.minEvents ?? 50;
  if (!Number.isFinite(minEvents) || minEvents! <= 0) {
    throw new SessionSplitterError('--min-events must be a positive integer');
  }

  if (!cliOptions.algo) {
    throw new SessionSplitterError('--algo option is required');
  }
  if (cliOptions.algo !== algoVersion) {
    throw new SessionSplitterError(
      `Algorithm mismatch: requested "${cliOptions.algo}" but library exports "${algoVersion}"`
    );
  }

  const jwtKey = process.env.JWT_HMAC_KEY;
  if (!jwtKey) {
    throw new SessionSplitterError('JWT_HMAC_KEY environment variable is required');
  }

  const splitOptions: SessionSplitOptions = {
    idleTimeoutSeconds: cliOptions.idleTimeout,
    timestampColumn: cliOptions.timestampColumn,
    userIdColumn: cliOptions.userColumn,
    sessionIdColumn: cliOptions.sessionColumn,
    jwtHmacKey: jwtKey,
    datasetKey: deriveDatasetKey(jwtKey)
  };

  const totalRecords = await countCsvRecords(cliOptions.in).catch(() => 0);
  const progress = new ProgressBar(totalRecords);
  const startTime = process.hrtime.bigint();
  let peakRss = process.memoryUsage().rss;
  let processed = 0;
  let headerWritten = false;
  let idleTimeoutSeconds = splitOptions.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const originalHeaders: string[] = [];
  const augmentedColumns: AugmentedColumnSpec[] = [
    { header: 'algo_ver', select: (row) => row.algo_ver },
    { header: 'uid', select: (row) => row.uid },
    { header: 'generated_session_id', select: (row) => row.generatedSessionId },
    { header: 'session_sequence', select: (row) => row.sessionSequence },
    { header: 'session_index', select: (row) => row.sessionIndex },
    { header: 'timestamp_utc', select: (row) => row.timestampUtc },
    { header: 'delta_seconds', select: (row) => row.deltaSeconds },
    { header: 'idle_timeout_seconds', select: (row) => row.idleTimeoutSeconds },
    { header: 'split_reason', select: (row) => row.splitReason },
    { header: 'original_session_id', select: (row) => row.originalSessionId ?? '' }
  ];

  const deltaMap = new Map<string, number[]>();
  await fsPromises.mkdir(path.dirname(cliOptions.out), { recursive: true });
  const outputStream = createWriteStream(cliOptions.out, { encoding: 'utf8' });

  try {
    for await (const row of splitSessions(cliOptions.in, splitOptions)) {
      if (!headerWritten) {
        idleTimeoutSeconds = row.idleTimeoutSeconds;
        originalHeaders.splice(0, originalHeaders.length, ...Object.keys(row.original));
        const headerRow = [
          ...augmentedColumns.map((column) => column.header),
          ...originalHeaders
        ];
        outputStream.write(`${headerRow.map(csvEscape).join(',')}\n`);
        headerWritten = true;
      }

      const augmentedValues = augmentedColumns.map((column) => column.select(row));
      const originalValues = originalHeaders.map((key) => row.original[key]);
      const csvRow = [...augmentedValues, ...originalValues].map(csvEscape).join(',');
      outputStream.write(`${csvRow}\n`);

      if (typeof row.deltaSeconds === 'number' && Number.isFinite(row.deltaSeconds) && row.deltaSeconds > 0) {
        const list = deltaMap.get(row.uid);
        if (list) {
          list.push(row.deltaSeconds);
        } else {
          deltaMap.set(row.uid, [row.deltaSeconds]);
        }
      }

      processed += 1;
      progress.update(processed);
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) {
        peakRss = rss;
      }
    }
  } catch (error) {
    throw error instanceof SessionSplitterError ? error : new SessionSplitterError('Failed to split sessions', error);
  } finally {
    outputStream.end();
    await finished(outputStream);
    progress.finish(processed);
  }

  const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1_000_000_000;

  const thresholdsResult = await estimateThresholdsWithMeta(
    createThresholdIterable(deltaMap, idleTimeoutSeconds),
    {
      minimumSamples: Math.floor(minEvents),
      knee: { kSigma: kneeSigma, logStep: scanStep },
      concurrency: cliOptions.concurrency,
      shard_dir: cliOptions.shardDir
    }
  );

  const thresholdsRecord = toSortedRecord(thresholdsResult.thresholds.entries());
  const perUserEntries = Array.from(thresholdsResult.perUser.entries());
  const fdBins = toSortedRecord(perUserEntries.map(([uid, detail]) => [uid, detail.fd_bins] as [string, number]));
  const tauOtsu = toSortedRecord(
    perUserEntries.map(([uid, detail]) => [uid, detail.tau_otsu] as [string, number | null])
  );
  const tauKnee = toSortedRecord(
    perUserEntries.map(([uid, detail]) => [uid, detail.tau_knee] as [string, number | null])
  );
  const tauFinal = toSortedRecord(perUserEntries.map(([uid, detail]) => [uid, detail.tau_final] as [string, number]));
  const deltaT = toSortedRecord(perUserEntries.map(([uid, detail]) => [uid, detail.DeltaT] as [string, number]));
  const bimodality = toSortedRecord(
    perUserEntries.map(([uid, detail]) => [uid, detail.bimodality_test] as [string, number | null])
  );
  const backoffLevel = toSortedRecord(
    perUserEntries.map(([uid, detail]) => [uid, detail.backoff_level] as [string, string])
  );

  await fsPromises.mkdir(path.dirname(cliOptions.meta), { recursive: true });
  const kid = cliOptions.kid ?? createHash('sha256').update(splitOptions.datasetKey!).digest('hex').slice(0, 32);
  const metaPayload: ThresholdMetaInput = {
    algo_ver: algoVersion,
    epsilon: epsilon!,
    ntp_p95_ms: 0,
    ingress_jitter_ms: 0,
    fd_bins: fdBins,
    tau_otsu: tauOtsu,
    tau_knee: tauKnee,
    tau_final: tauFinal,
    DeltaT: deltaT,
    bimodality_test: bimodality,
    backoff_level: backoffLevel,
    k: thresholdsResult.k,
    scan_step: thresholdsResult.scan_step,
    hkdf_info: HKDF_INFO_BASE64,
    kid,
    datasetPath: cliOptions.in,
    thresholds_by_uid: thresholdsRecord
  };
  await writeMeta(cliOptions.meta, metaPayload);

  const summary = {
    event: 'split_sessions_complete',
    rows_processed: processed,
    duration_seconds: Number.isFinite(durationSeconds) ? Number(durationSeconds.toFixed(6)) : durationSeconds,
    peak_rss_bytes: peakRss,
    output_path: path.resolve(cliOptions.out),
    meta_path: path.resolve(cliOptions.meta)
  };
  process.stderr.write(`[split-sessions] ${JSON.stringify(summary)}\n`);
}

const program = new Command();
program
  .name('split-sessions')
  .description('Batch session splitting CLI for Δt-aware session segmentation')
  .requiredOption('--in <path>', 'Path to input CSV file')
  .requiredOption('--out <path>', 'Path to write augmented CSV output')
  .option('--meta <path>', 'Path to write threshold metadata JSON', 'meta.json')
  .option('--epsilon <seconds>', 'Half of log resolution in seconds', (value) => Number(value))
  .option('--k <sigma>', 'K-sigma span for knee detection', (value) => Number(value))
  .option('--scan-step <step>', 'Log-domain scan step for knee detection', (value) => Number(value))
  .option('--min-events <count>', 'Minimum events per user for Otsu+knee', (value) => Number(value))
  .option('--kid <identifier>', 'Key identifier to record in metadata')
  .option('--algo <name>', 'Algorithm version label')
  .option('--idle-timeout <seconds>', 'Idle timeout seconds override', (value) => Number(value))
  .option('--timestamp-column <name>', 'Timestamp column override')
  .option('--user-column <name>', 'User identifier column override')
  .option('--session-column <name>', 'Original session identifier column override')
  .option('--concurrency <count>', 'Worker threads for threshold estimation', (value) => Number(value))
  .option('--shard-dir <path>', 'Directory for temporary threshold shards')
  .action(async (cliOptions: BulkCliOptions) => {
    try {
      await run(cliOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[split-sessions] error: ${message}`);
      if (error instanceof SessionSplitterError && (error as { cause?: unknown }).cause) {
        console.error(`[split-sessions] cause:`, (error as { cause?: unknown }).cause);
      }
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
