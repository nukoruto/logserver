#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { fitAnomalyModel } from './fit.js';
import { scoreStream } from './score.js';
import { parseQuantileLevels } from './utils.js';

const program = new Command();

const parseFloatArg = (value: string): number => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError('Expected a finite number but received an empty string');
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`Expected a finite number but received "${value}"`);
  }
  return parsed;
};

const parseIntArg = (value: string): number => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError('Expected an integer but received an empty string');
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError(`Expected an integer but received "${value}"`);
  }
  return parsed;
};

interface FitCommandOptions {
  readonly input: string[];
  readonly statsOut: string;
  readonly metaOut: string;
  readonly column: string;
  readonly quantile?: string;
  readonly quantileLower: number;
  readonly quantileUpper: number;
  readonly minQuantileSamples: number;
  readonly budgetTotal: number;
  readonly budgetWeightMode?: 'count' | 'uniform';
  readonly spotDomain: 'log_dt' | 'z_deseas';
  readonly spotCalibCount?: number;
  readonly spotCalibStart?: string;
  readonly spotCalibEnd?: string;
  readonly spotP0: string;
  readonly minTail: number;
  readonly flagTailProb: number;
  readonly alpha: number;
  readonly q: number;
  readonly calibWindow: number;
  readonly declusterR: number;
  readonly kofn: string;
  readonly H: number;
  readonly reestimateEvery: number;
  readonly minExceed: number;
  readonly poolStrategy: string;
  readonly xiEps: number;
  readonly upperCapPerDay: number;
  readonly lowerClip: number;
  readonly seed: string;
  readonly preprocHash: string;
}

interface ScoreCommandOptions {
  readonly input: string;
  readonly output: string;
  readonly stats: string;
  readonly meta: string;
  readonly audit: string;
}

interface KOfNParams {
  readonly k: number;
  readonly n: number;
}

const parseKOfN = (value: string): KOfNParams => {
  const parts = value.split('/');
  if (parts.length !== 2) {
    throw new InvalidArgumentError('Expected format <k>/<n> for --kofn');
  }
  const k = parseIntArg(parts[0]);
  const n = parseIntArg(parts[1]);
  if (!(k >= 1 && n >= 1 && k <= n)) {
    throw new InvalidArgumentError('--kofn requires integers with 1 <= k <= n');
  }
  return { k, n };
};
program
  .name('dt-anom')
  .description('Δt anomaly scoring pipeline with SPOT initialization');

program
  .command('fit')
  .requiredOption('-i, --input <files...>', 'Input CSV files (dt-preproc output)')
  .requiredOption('-s, --stats-out <path>', 'Output anomaly stats JSON')
  .requiredOption('-m, --meta-out <path>', 'Output anomaly meta JSON')
  .option('-c, --column <name>', 'Base column to score', 'dt_sec')
  .option('--quantile <values>', 'Quantile levels (comma-separated)')
  .option('--quantile-lower <value>', 'Lower quantile for tau_lo', parseFloatArg, 0.01)
  .option('--quantile-upper <value>', 'Upper quantile for tau_hi', parseFloatArg, 0.99)
  .option(
    '--min-quantile-samples <count>',
    'Minimum samples required for (uid, op_category) quantile without fallback',
    parseIntArg,
    30
  )
  .option('--budget-total <value>', 'Global probability budget Q_total', parseFloatArg, 1e-2)
  .option('--budget-weight-mode <mode>', 'Weight mode for budget allocation (count|uniform)', 'count')
  .option('--spot-domain <value>', 'SPOT calibration domain (log_dt|z_deseas)', 'log_dt')
  .option('--spot-calib-count <value>', 'Initial record count for SPOT calibration', parseIntArg)
  .option('--spot-calib-start <value>', 'Inclusive ISO8601 start timestamp for SPOT calibration range')
  .option('--spot-calib-end <value>', 'Inclusive ISO8601 end timestamp for SPOT calibration range')
  .option(
    '--spot-p0 <values>',
    'Candidate quantiles for SPOT baseline threshold (comma-separated)',
    '0.9,0.93,0.95,0.975,0.99'
  )
  .option('--min-tail <count>', 'Minimum tail sample count', parseIntArg, 50)
  .option('--flag-tail-prob <value>', 'Tail probability threshold for flagging', parseFloatArg, 1e-3)
  .option('--alpha <value>', 'Score combination coefficient', parseFloatArg, 0.5)
  .option('--q <value>', 'Quantile target for control rules', parseFloatArg, 0.99)
  .option('--calib-window <value>', 'Calibration window length', parseIntArg, 1000)
  .option('--decluster-r <value>', 'Declustering separation parameter', parseIntArg, 5)
  .option('--kofn <k>/<n>', 'k-of-n voting parameters', '3/5')
  .option('--H <value>', 'Hysteresis ratio (>1)', parseFloatArg, 1.1)
  .option('--reestimate-every <value>', 'Re-estimation interval (events)', parseIntArg, 10000)
  .option('--min-exceed <value>', 'Minimum exceedances before alarm', parseIntArg, 5)
  .option('--pool-strategy <value>', 'Pooling strategy for group tail statistics', 'per-user')
  .option('--xi-eps <value>', 'Xi epsilon for stability', parseFloatArg, 1e-3)
  .option('--upper-cap-per-day <value>', 'Upper cap per day', parseIntArg, 50)
  .option('--lower-clip <value>', 'Lower clip value', parseFloatArg, -5)
  .option('--seed <values>', 'Random seeds used in upstream stages (comma-separated)', '0')
  .requiredOption('--preproc-hash <value>', 'Preprocessing pipeline hash (SHA-256)')
  .action(async (rawOptions: unknown) => {
    const cmdOpts = rawOptions as FitCommandOptions;
    const parseList = (value: string | undefined, parser: (item: string) => number): number[] => {
      if (!value || value.trim().length === 0) {
        return [];
      }
      return value
        .split(',')
        .map((item) => parser(item.trim()))
        .filter((item) => Number.isFinite(item));
    };
    const quantiles = parseQuantileLevels(
      cmdOpts.quantile ? parseList(cmdOpts.quantile, parseFloatArg) : [0.9, 0.95, 0.99, 0.995]
    );
    const spotCandidates = parseQuantileLevels(parseList(cmdOpts.spotP0, parseFloatArg));
    const seeds = parseList(cmdOpts.seed, parseIntArg).map((value) => Math.trunc(value));
    if (seeds.length === 0) {
      throw new Error('At least one seed must be provided');
    }
    const kofnParsed = parseKOfN(cmdOpts.kofn ?? '3/5');
    const budgetWeightMode = cmdOpts.budgetWeightMode ?? 'count';
    const result = await fitAnomalyModel({
      inputs: cmdOpts.input,
      statsOut: cmdOpts.statsOut,
      metaOut: cmdOpts.metaOut,
      baseColumn: cmdOpts.column,
      quantiles,
      quantileLower: cmdOpts.quantileLower,
      quantileUpper: cmdOpts.quantileUpper,
      minQuantileSamples: cmdOpts.minQuantileSamples,
      budgetTotal: cmdOpts.budgetTotal ?? 1e-2,
      budgetWeightMode,
      spotDomain: cmdOpts.spotDomain,
      spotCalibCount: cmdOpts.spotCalibCount,
      spotCalibStart: cmdOpts.spotCalibStart,
      spotCalibEnd: cmdOpts.spotCalibEnd,
      spotQuantileCandidates: spotCandidates,
      minTailCount: cmdOpts.minTail,
      flagTailProbability: cmdOpts.flagTailProb,
      alpha: cmdOpts.alpha,
      q: cmdOpts.q,
      calibWindow: cmdOpts.calibWindow,
      declusterR: cmdOpts.declusterR,
      kofn: [kofnParsed.k, kofnParsed.n],
      H: cmdOpts.H,
      reestimateEvery: cmdOpts.reestimateEvery,
      minExceed: cmdOpts.minExceed,
      poolStrategy: cmdOpts.poolStrategy,
      xiEps: cmdOpts.xiEps,
      upperCapPerDay: cmdOpts.upperCapPerDay,
      lowerClip: cmdOpts.lowerClip,
      seeds,
      preprocHash: cmdOpts.preprocHash
    });
    process.stdout.write(
      JSON.stringify(
        {
          stats: result.stats,
          meta: result.meta
        },
        null,
        2
      ) + '\n'
    );
  });

program
  .command('score')
  .requiredOption('-i, --input <path>', 'Input CSV to score')
  .requiredOption('-o, --output <path>', 'Output CSV with anomaly columns appended')
  .requiredOption('--stats <path>', 'Fitted anomaly stats JSON')
  .requiredOption('--meta <path>', 'Fitted anomaly meta JSON')
  .requiredOption('--audit <path>', 'Audit JSONL output for SPOT decisions')
  .action(async (rawOptions: unknown) => {
    const cmdOpts = rawOptions as ScoreCommandOptions;
    const summary = await scoreStream({
      input: cmdOpts.input,
      output: cmdOpts.output,
      statsPath: cmdOpts.stats,
      metaPath: cmdOpts.meta,
      auditPath: cmdOpts.audit
    });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  });

program
  .command('recalibrate')
  .description('Hierarchical SPOT calibration requires rerunning fit; this command is disabled')
  .action(async () => {
    throw new Error('Hierarchical SPOT recalibration is not supported. Please rerun dt-anom fit.');
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
