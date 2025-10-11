#!/usr/bin/env node
import { createHash } from 'node:crypto';
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
  ntpP95Ms?: number;
  ingressJitterMs?: number;
}

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
  .option('--ntp-p95-ms <ms>', '95th percentile NTP offset in milliseconds', (value) => Number(value))
  .option('--ingress-jitter-ms <ms>', 'Ingress jitter bound in milliseconds', (value) => Number(value))
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
        const result = estimateThresholdsWithMeta(rows);
        const thresholdsRecord = toSortedRecord(result.thresholds.entries());
        process.stdout.write(
          `${JSON.stringify({ algo_ver: algoVersion, thresholds: thresholdsRecord })}\n`
        );

        const perUserEntries = Array.from(result.perUser.entries());
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

        const epsilon =
          typeof cliOptions.epsilon === 'number' && Number.isFinite(cliOptions.epsilon)
            ? cliOptions.epsilon
            : 0;
        const ntpP95 =
          typeof cliOptions.ntpP95Ms === 'number' && Number.isFinite(cliOptions.ntpP95Ms)
            ? cliOptions.ntpP95Ms
            : 0;
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
