#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
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

const collectFloats = (value: string, previous: number[] | undefined): number[] => {
  const acc = previous ?? [];
  acc.push(parseFloatArg(value));
  return acc;
};

const collectIntegers = (value: string, previous: number[] | undefined): number[] => {
  const acc = previous ?? [];
  acc.push(parseIntArg(value));
  return acc;
};

interface KOfNParams {
  readonly k: number;
  readonly n: number;
}

interface FitCommandOptions {
  readonly input: string[];
  readonly statsOut: string;
  readonly metaOut: string;
  readonly column: string;
  readonly quantile?: number[];
  readonly quantileLower: number;
  readonly quantileUpper: number;
  readonly minQuantileSamples: number;
  readonly budgetTotal: number;
  readonly budgetWeightMode?: 'count' | 'uniform';
  readonly spotDomain: 'log_dt' | 'z_deseas';
  readonly spotCalibCount?: number;
  readonly spotCalibStart?: string;
  readonly spotCalibEnd?: string;
  readonly spotP0: number[];
  readonly minTail: number;
  readonly flagTailProb: number;
  readonly algoVer: string;
  readonly alpha: number;
  readonly q: number;
  readonly calibWindow: number;
  readonly declusterR: number;
  readonly kofn: KOfNParams;
  readonly hysteresisGamma: number;
  readonly reestimateEvery: number;
  readonly minExceed: number;
  readonly poolStrategy: string;
  readonly xiEps: number;
  readonly upperCapPerDay: number;
  readonly lowerClip: number;
  readonly seed: number[];
  readonly preprocHash: string;
}

interface ScoreCommandOptions {
  readonly input: string;
  readonly output: string;
  readonly stats: string;
  readonly meta: string;
  readonly audit: string;
  readonly flagTailProb?: number;
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
  .addOption(
    new Option('--quantile <values...>', 'Quantile levels (0-1)').argParser(collectFloats)
  )
  .addOption(
    new Option('--quantile-lower <value>', 'Lower quantile for tau_lo')
      .default(0.01)
      .argParser(parseFloatArg)
  )
  .addOption(
    new Option('--quantile-upper <value>', 'Upper quantile for tau_hi')
      .default(0.99)
      .argParser(parseFloatArg)
  )
  .addOption(
    new Option(
      '--min-quantile-samples <count>',
      'Minimum samples required for (uid, op_category) quantile without fallback'
    )
      .default(30)
      .argParser(parseIntArg)
  )
  .addOption(
    new Option('--budget-total <value>', 'Global probability budget Q_total')
      .default(1e-2)
      .argParser(parseFloatArg)
  )
  .addOption(
    new Option('--budget-weight-mode <mode>', 'Weight mode for budget allocation (count|uniform)')
      .choices(['count', 'uniform'])
      .default('count')
  )
  .addOption(
    new Option('--spot-domain <value>', 'SPOT calibration domain (log_dt|z_deseas)')
      .choices(['log_dt', 'z_deseas'])
      .default('log_dt')
  )
  .addOption(
    new Option('--spot-calib-count <value>', 'Initial record count for SPOT calibration').argParser(parseIntArg)
  )
  .option('--spot-calib-start <value>', 'Inclusive ISO8601 start timestamp for SPOT calibration range')
  .option('--spot-calib-end <value>', 'Inclusive ISO8601 end timestamp for SPOT calibration range')
  .addOption(
    new Option('--spot-p0 <values...>', 'Candidate quantiles for SPOT baseline threshold')
      .default([0.9, 0.93, 0.95, 0.975, 0.99])
      .argParser(collectFloats)
  )
  .addOption(
    new Option('--min-tail <count>', 'Minimum tail sample count').default(50).argParser(parseIntArg)
  )
  .addOption(
    new Option('--flag-tail-prob <value>', 'Tail probability threshold for flagging')
      .default(1e-3)
      .argParser(parseFloatArg)
  )
  .option('--algo-ver <value>', 'Algorithm version identifier', '1.0.0')
  .addOption(
    new Option('--alpha <value>', 'Score combination coefficient').default(0.5).argParser(parseFloatArg)
  )
  .addOption(new Option('--q <value>', 'Quantile target for control rules').default(0.99).argParser(parseFloatArg))
  .addOption(
    new Option('--calib-window <value>', 'Calibration window length').default(1000).argParser(parseIntArg)
  )
  .addOption(
    new Option('--decluster-r <value>', 'Declustering separation parameter').default(5).argParser(parseIntArg)
  )
  .addOption(
    new Option('--kofn <k>/<n>', 'k-of-n voting parameters')
      .default(parseKOfN('3/5'))
      .argParser(parseKOfN)
  )
  .addOption(
    new Option('--hysteresis-gamma <value>', 'Hysteresis gain (>1)')
      .default(1.5)
      .argParser(parseFloatArg)
  )
  .addOption(
    new Option('--reestimate-every <value>', 'Re-estimation interval (events)')
      .default(10000)
      .argParser(parseIntArg)
  )
  .addOption(
    new Option('--min-exceed <value>', 'Minimum exceedances before alarm').default(5).argParser(parseIntArg)
  )
  .option('--pool-strategy <value>', 'Pooling strategy for group tail statistics', 'per-user')
  .addOption(new Option('--xi-eps <value>', 'Xi epsilon for stability').default(1e-3).argParser(parseFloatArg))
  .addOption(
    new Option('--upper-cap-per-day <value>', 'Upper cap per day').default(50).argParser(parseIntArg)
  )
  .addOption(
    new Option('--lower-clip <value>', 'Lower clip value').default(-5).argParser(parseFloatArg)
  )
  .addOption(
    new Option('--seed <values...>', 'Random seeds used in upstream stages')
      .default([0])
      .argParser(collectIntegers)
  )
  .requiredOption('--preproc-hash <value>', 'Preprocessing pipeline hash (SHA-256)')
    .action(async (rawOptions: unknown) => {
      const cmdOpts = rawOptions as FitCommandOptions;
      const quantiles = cmdOpts.quantile ? parseQuantileLevels(cmdOpts.quantile) : [0.9, 0.95, 0.99, 0.995];
      const seeds = cmdOpts.seed ?? [];
      if (seeds.length === 0) {
        throw new Error('At least one seed must be provided');
      }
      const kofnOption = cmdOpts.kofn;
      const kofnValues: [number, number] = [kofnOption.k, kofnOption.n];
      const budgetWeightMode = cmdOpts.budgetWeightMode ?? 'count';
      if (!(Number.isFinite(cmdOpts.hysteresisGamma) && cmdOpts.hysteresisGamma > 1)) {
        throw new Error('--hysteresis-gamma must be greater than 1');
      }
      const spotCandidates = cmdOpts.spotP0;
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
        algoVer: cmdOpts.algoVer,
        alpha: cmdOpts.alpha,
        q: cmdOpts.q,
        calibWindow: cmdOpts.calibWindow,
        declusterR: cmdOpts.declusterR,
        kofn: kofnValues,
        hysteresisGamma: cmdOpts.hysteresisGamma,
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
  .addOption(
    new Option('--flag-tail-prob <value>', 'Override tail probability threshold').argParser(parseFloatArg)
  )
  .action(async (rawOptions: unknown) => {
    const cmdOpts = rawOptions as ScoreCommandOptions;
    const summary = await scoreStream({
      input: cmdOpts.input,
      output: cmdOpts.output,
      statsPath: cmdOpts.stats,
      metaPath: cmdOpts.meta,
      auditPath: cmdOpts.audit,
      overrideFlagTailProbability: cmdOpts.flagTailProb
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
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

await main();
