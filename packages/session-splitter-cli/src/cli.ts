#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import {
  algoVersion,
  deriveDatasetKey,
  estimateThresholdsWithMeta,
  splitSessions,
  SessionSplitOptions,
  AugmentedRow,
  writeMeta
} from '@logserver/session-splitter';
import type { ThresholdMetaInput } from '@logserver/session-splitter';

const HKDF_INFO_BASE64 = Buffer.from('sid', 'utf8').toString('base64');

function toSortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  const sorted = Array.from(entries).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(sorted);
}

interface CliOptions {
  input: string;
  idleTimeout?: number;
  format: 'ndjson' | 'json';
  thresholds: boolean;
  timestampColumn?: string;
  userIdColumn?: string;
  sessionIdColumn?: string;
  meta?: string;
  epsilon?: number;
  ntpP95Ms?: number | 'auto';
  ingressJitterMs?: number;
  concurrency?: number;
  shardDir?: string;
}

const DEFAULT_NTP_STATE_PATH = path.join(process.cwd(), 'state', 'ntp.json');
const MAX_NTP_P95_MS = 50;

type ResolvedNtpMeasurement = {
  p95Ms: number;
  lastMeasuredAt: number | null;
  source: 'cli' | 'state';
};

const parseTimestampToEpoch = (value: unknown): number | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const resolveNtpMeasurement = async (options: CliOptions): Promise<ResolvedNtpMeasurement> => {
  if (typeof options.ntpP95Ms === 'number' && Number.isFinite(options.ntpP95Ms)) {
    return { p95Ms: options.ntpP95Ms, lastMeasuredAt: Date.now(), source: 'cli' };
  }

  const statePath = process.env.NTP_STATE_PATH
    ? path.resolve(process.env.NTP_STATE_PATH)
    : DEFAULT_NTP_STATE_PATH;
  let raw: string;
  try {
    raw = await fs.readFile(statePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`NTP measurement not found at ${statePath}: ${message}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${statePath}: ${message}`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`NTP state at ${statePath} is not an object`);
  }

  const ntpP95Candidate = Number((payload as Record<string, unknown>).p95_ms);
  if (!Number.isFinite(ntpP95Candidate)) {
    throw new Error(`NTP state at ${statePath} is missing numeric p95_ms`);
  }

  const lastMeasuredCandidate = parseTimestampToEpoch((payload as Record<string, unknown>).lastMeasuredAt);
  return { p95Ms: ntpP95Candidate, lastMeasuredAt: lastMeasuredCandidate, source: 'state' };
};

const program = new Command();

program
  .name('session-splitter')
  .description('Split session logs using the shared session splitter library')
  .option('-i, --input <path>', 'Path to the input CSV file')
  .option('-t, --idle-timeout <seconds>', 'Idle timeout seconds', (value) => Number(value))
  .option('-f, --format <format>', 'Output format: ndjson or json', 'ndjson')
  .option('--timestamp-column <name>', 'Timestamp column name override')
  .option('--user-column <name>', 'User identifier column name override')
  .option('--session-column <name>', 'Raw session identifier column name')
  .option('--thresholds', 'Emit per-user threshold summary as JSON', false)
  .option('--meta <path>', 'Path to write meta.json (default: ./meta.json)', 'meta.json')
  .option('--epsilon <seconds>', 'Half of log resolution in seconds', (value) => Number(value))
  .option('--ntp-p95-ms <ms>', '95th percentile NTP offset in milliseconds or "auto"', (value) =>
    value === 'auto' ? 'auto' : Number(value)
  )
  .option('--ingress-jitter-ms <ms>', 'Ingress jitter bound in milliseconds', (value) => Number(value))
  .option('--concurrency <count>', 'Worker threads for threshold estimation', (value) => Number(value))
  .option('--shard-dir <path>', 'Directory for temporary threshold shards')
  .action(async (cliOptions: CliOptions) => {
    if (!cliOptions.input) {
      console.error('Input path is required. Use --input <path>');
      process.exitCode = 1;
      return;
    }

    const splitOptions: SessionSplitOptions = {
      idleTimeoutSeconds: cliOptions.idleTimeout,
      timestampColumn: cliOptions.timestampColumn,
      userIdColumn: cliOptions.userIdColumn,
      sessionIdColumn: cliOptions.sessionIdColumn
    };

    const jwtHmacKey = process.env.JWT_HMAC_KEY;
    if (!jwtHmacKey) {
      console.error('JWT_HMAC_KEY environment variable is required to derive session IDs');
      process.exitCode = 1;
      return;
    }

    const datasetKey = deriveDatasetKey(jwtHmacKey);
    splitOptions.jwtHmacKey = jwtHmacKey;
    splitOptions.datasetKey = datasetKey;

    let resolvedNtp: ResolvedNtpMeasurement;
    try {
      resolvedNtp = await resolveNtpMeasurement(cliOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`session-splitter NTP gate failed: ${message}`);
      process.exitCode = 2;
      return;
    }

    if (resolvedNtp.p95Ms > MAX_NTP_P95_MS) {
      console.error(
        `session-splitter NTP gate failed: ntp_p95_ms=${resolvedNtp.p95Ms}ms exceeds ${MAX_NTP_P95_MS}ms`
      );
      process.exitCode = 2;
      return;
    }

    const rows: AugmentedRow[] = [];

    try {
      for await (const row of splitSessions(cliOptions.input, splitOptions)) {
        rows.push(row);
        if (cliOptions.format === 'ndjson') {
          process.stdout.write(`${JSON.stringify(row)}\n`);
        }
      }

      if (cliOptions.format === 'json') {
        process.stdout.write(
          `${JSON.stringify({ algo_ver: algoVersion, rows })}\n`
        );
      }

      if (cliOptions.thresholds) {
        const result = await estimateThresholdsWithMeta(rows, {
          minEvents: 1,
          min_events: 1,
          concurrency: cliOptions.concurrency,
          shard_dir: cliOptions.shardDir
        });
        const thresholdsRecord = toSortedRecord(result.thresholds.entries());
        process.stdout.write(
          `${JSON.stringify({ algo_ver: algoVersion, thresholds: thresholdsRecord })}\n`
        );

        type PerUserEntry = [string, NonNullable<ReturnType<typeof result.perUser.get>>];
        const perUserEntries = Array.from(result.perUser.entries()) as PerUserEntry[];
        const fdBins = toSortedRecord(
          perUserEntries.map(([uid, detail]) => [uid, detail.fd_bins] as [string, number])
        );
        const tauOtsu = toSortedRecord(
          perUserEntries.map(([uid, detail]) => [uid, detail.tau_otsu] as [string, number | null])
        );
        const tauKnee = toSortedRecord(
          perUserEntries.map(([uid, detail]) => [uid, detail.tau_knee] as [string, number | null])
        );
        const tauFinal = toSortedRecord(
          perUserEntries.map(([uid, detail]) => [uid, detail.tau_final] as [string, number])
        );
        const deltaT = toSortedRecord(
          perUserEntries.map(([uid, detail]) => [uid, detail.DeltaT] as [string, number])
        );
        const bimodality = toSortedRecord(
          perUserEntries.map(([uid, detail]) => [uid, detail.bimodality_test] as [string, number | null])
        );
        const backoffLevel = toSortedRecord(
          perUserEntries.map(([uid, detail]) => [uid, detail.backoff_level] as [string, string])
        );

        const epsilon =
          typeof cliOptions.epsilon === 'number' && Number.isFinite(cliOptions.epsilon)
            ? cliOptions.epsilon
            : 0;
        const ntpP95 = resolvedNtp.p95Ms;
        const ingressJitter =
          typeof cliOptions.ingressJitterMs === 'number' && Number.isFinite(cliOptions.ingressJitterMs)
            ? cliOptions.ingressJitterMs
            : 0;
        const metaTarget = cliOptions.meta ?? path.join(path.dirname(cliOptions.input), 'meta.json');

        const metaPayload: ThresholdMetaInput = {
          algo_ver: algoVersion,
          epsilon,
          ntp_p95_ms: ntpP95,
          ingress_jitter_ms: ingressJitter,
          fd_bins: fdBins,
          tau_otsu: tauOtsu,
          tau_knee: tauKnee,
          tau_final: tauFinal,
          DeltaT: deltaT,
          bimodality_test: bimodality,
          backoff_level: backoffLevel,
          k: result.k,
          scan_step: result.scan_step,
          hkdf_info: HKDF_INFO_BASE64,
          kid: createHash('sha256').update(datasetKey).digest('hex').slice(0, 32),
          datasetPath: cliOptions.input,
          thresholds_by_uid: thresholdsRecord
        };

        await writeMeta(metaTarget, metaPayload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`session-splitter error: ${message}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
