#!/usr/bin/env node
import { Command } from 'commander';
import {
  algoVersion,
  estimateThresholdsByUser,
  splitSessions,
  SessionSplitOptions,
  AugmentedRow
} from '@logserver/session-splitter';

interface CliOptions {
  input: string;
  idleTimeout?: number;
  format: 'ndjson' | 'json';
  thresholds: boolean;
  timestampColumn?: string;
  userIdColumn?: string;
  sessionIdColumn?: string;
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
        const thresholds = estimateThresholdsByUser(rows);
        process.stdout.write(
          `${JSON.stringify({ algo_ver: algoVersion, thresholds: Object.fromEntries(thresholds) })}\n`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`session-splitter error: ${message}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
