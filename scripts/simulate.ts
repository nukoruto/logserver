import '../collector/src/bootstrap/env';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import collectorConfig from '../collector/src/config';
import { normalizeAnomalyList } from '../collector/src/services/simulationService';
import { HealthError } from '../collector/src/healthGate';
import { runSimulation, type SimulationRunnerOptions } from '../collector/src/simRunner';

const requireFromCollector = createRequire(path.resolve(__dirname, '../collector/package.json'));
const yargs = requireFromCollector('yargs/yargs');
const { hideBin } = requireFromCollector('yargs/helpers');

type CliOptions = {
  count: number;
  anomalies?: string | string[];
  seed?: string;
  scenario?: string;
  anomalyRate?: number;
  anomalyCount?: number;
  outputDir?: string;
  csvFile?: string;
  manifestFile?: string;
  runId?: string;
  persist: boolean;
  start?: string;
  sessionSpacing?: number;
  maxSteps?: number;
  pretty: boolean;
  timeAnomalyMode?: string;
  timeAnomalyPropWeight?: number;
  deltaEpsilon?: number;
  includeFeatures?: boolean;
  featureFile?: string;
  ntpP95Ms?: string;
  ntpLastMeasuredAt?: string;
  ntpStatePath?: string;
  ntpFreshnessMs?: number;
  jwtIssuer?: string | string[];
};

const normalizeAnomaliesArg = (input: CliOptions['anomalies']): string[] => {
  if (!input) {
    return [];
  }
  const values = Array.isArray(input) ? input : String(input).split(',');
  const normalized = Array.from(normalizeAnomalyList(values)).map((item) => item);
  return normalized;
};

const normalizeIssuersArg = (input: CliOptions['jwtIssuer']): string[] => {
  if (!input) {
    return [];
  }
  const values = Array.isArray(input) ? input : [input];
  const sanitized = values
    .map((issuer) => issuer.trim())
    .filter((issuer) => issuer.length > 0);
  return Array.from(new Set(sanitized));
};

const main = async (): Promise<void> => {
  const parser = yargs(hideBin(process.argv))
    .scriptName('simulate')
    .usage('Usage: $0 [options]')
    .option('count', {
      type: 'number',
      describe: 'Number of events to generate (will be truncated to this length).',
      default: 64,
    })
    .option('anomalies', {
      type: 'string',
      describe: 'Comma-separated anomaly strategies (time,auth,protocol).',
    })
    .option('seed', {
      type: 'string',
      describe: 'Seed value for deterministic generation.',
    })
    .option('scenario', {
      type: 'string',
      describe: 'Scenario JSON file path. Defaults to configs/scenario_default.json when available.',
    })
    .option('anomaly-rate', {
      type: 'number',
      describe: 'Target anomaly rate (0-1).',
    })
    .option('anomaly-count', {
      type: 'number',
      describe: 'Explicit anomaly count override.',
    })
    .option('output-dir', {
      type: 'string',
      describe: 'Directory to persist CSV/manifest output.',
    })
    .option('csv-file', {
      type: 'string',
      describe: 'Custom CSV filename.',
    })
    .option('manifest-file', {
      type: 'string',
      describe: 'Custom manifest filename.',
    })
    .option('include-features', {
      type: 'boolean',
      default: false,
      describe: 'Emit derived feature columns into a separate CSV alongside the contract CSV.',
    })
    .option('feature-file', {
      type: 'string',
      describe: 'Custom filename for the derived feature CSV (requires --include-features).',
    })
    .option('ntp-p95-ms', {
      type: 'string',
      describe: 'NTP 95th percentile offset in milliseconds or "auto" to read from state/ntp.json.',
      default: 'auto',
    })
    .option('ntp-last-measured-at', {
      type: 'string',
      describe: 'ISO8601 or epoch milliseconds timestamp for the NTP measurement.',
    })
    .option('ntp-state-path', {
      type: 'string',
      describe: 'Path to the NTP measurement JSON file (default: ./state/ntp.json).',
    })
    .option('ntp-freshness-ms', {
      type: 'number',
      describe: 'Override freshness window (milliseconds) before the NTP measurement is considered stale.',
    })
    .option('run-id', {
      type: 'string',
      describe: 'Run identifier for manifest naming.',
    })
    .option('persist', {
      type: 'boolean',
      default: true,
      describe: 'Persist outputs to disk (use --no-persist to disable).',
    })
    .option('jwt-issuer', {
      type: 'string',
      describe: 'Allowed JWT issuer (repeat to specify multiple entries).',
      array: true,
    })
    .option('start', {
      type: 'string',
      describe: 'ISO8601 timestamp to start the first session.',
    })
    .option('session-spacing', {
      type: 'number',
      describe: 'Spacing between session start times (seconds).',
    })
    .option('max-steps', {
      type: 'number',
      describe: 'Maximum transitions per session before termination.',
    })
    .option('delta-epsilon', {
      type: 'number',
      describe: 'Minimum Δt floor epsilon applied to generated intervals (seconds).',
      default: collectorConfig.deltaEpsilon,
    })
    .option('time-anomaly-mode', {
      type: 'string',
      describe: 'Time anomaly propagation mode (auto|propagate|local).',
      choices: ['auto', 'propagate', 'local'],
      default: collectorConfig.timeAnomalyMode,
    })
    .option('time-anomaly-prop-weight', {
      type: 'number',
      describe: 'Propagation weight for auto mode (0..1).',
      default: 0.7,
    })
    .option('pretty', {
      type: 'boolean',
      default: false,
      describe: 'Pretty-print JSON output.',
    })
    .help('help')
    .alias('help', 'h')
    .strict();

  const argv = (await parser.parseAsync()) as unknown as CliOptions;

  try {
    const anomalies = normalizeAnomaliesArg(argv.anomalies);
    const allowedIssuers = normalizeIssuersArg(argv.jwtIssuer);
    const ntpOverrideRaw = typeof argv.ntpP95Ms === 'string' ? argv.ntpP95Ms.trim() : undefined;
    const shouldOverrideNtp =
      typeof ntpOverrideRaw === 'string' && ntpOverrideRaw.length > 0 && ntpOverrideRaw.toLowerCase() !== 'auto';

    const simulationOptions: SimulationRunnerOptions = {
      count: argv.count,
      anomalies,
      seed: argv.seed,
      scenarioPath: argv.scenario,
      anomalyRate: argv.anomalyRate,
      anomalyCount: argv.anomalyCount,
      outputDir: argv.outputDir,
      csvFileName: argv.csvFile,
      featureCsvFileName: argv.featureFile,
      manifestFileName: argv.manifestFile,
      runId: argv.runId,
      persist: argv.persist,
      startTime: argv.start,
      sessionSpacingSeconds: argv.sessionSpacing,
      maxSteps: argv.maxSteps,
      timeAnomalyMode: argv.timeAnomalyMode,
      timeAnomalyPropWeight: argv.timeAnomalyPropWeight,
      deltaEpsilon: argv.deltaEpsilon,
      includeFeaturesCsv: argv.includeFeatures,
      ntpStatePath: argv.ntpStatePath,
      freshnessMs: argv.ntpFreshnessMs,
      jwtIssuers: allowedIssuers,
    };

    if (shouldOverrideNtp && ntpOverrideRaw !== undefined) {
      const numericOverride = Number(ntpOverrideRaw);
      simulationOptions.ntpP95MsOverride = Number.isFinite(numericOverride) ? numericOverride : ntpOverrideRaw;
      simulationOptions.ntpLastMeasuredAtOverride = argv.ntpLastMeasuredAt ?? new Date().toISOString();
    } else if (argv.ntpLastMeasuredAt) {
      simulationOptions.ntpLastMeasuredAtOverride = argv.ntpLastMeasuredAt;
    }

    const result = await runSimulation(simulationOptions);

    const indent = argv.pretty ? 2 : 0;
    process.stdout.write(`${JSON.stringify(result, null, indent)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[simulate] ${message}`);
    process.exitCode = error instanceof HealthError ? 2 : 1;
  }
};

void main();
