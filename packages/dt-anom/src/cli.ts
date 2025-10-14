#!/usr/bin/env node
import { Command } from 'commander';
import { fitAnomalyModel } from './fit.js';
import { scoreStream } from './score.js';
import { parseQuantileLevels } from './utils.js';

const program = new Command();
program
  .name('dt-anom')
  .description('Δt anomaly scoring pipeline with SPOT initialization');

program
  .command('fit')
  .requiredOption('-i, --input <files...>', 'Input CSV files (dt-preproc output)')
  .requiredOption('-s, --stats-out <path>', 'Output anomaly stats JSON')
  .requiredOption('-m, --meta-out <path>', 'Output anomaly meta JSON')
  .option('-c, --column <name>', 'Base column to score', 'dt_sec')
  .option('--quantile <values...>', 'Quantile levels (0-1)', (values: string[]) => values.map(Number))
  .option('--quantile-lower <value>', 'Lower quantile for tau_lo', (value) => Number(value), 0.01)
  .option('--quantile-upper <value>', 'Upper quantile for tau_hi', (value) => Number(value), 0.99)
  .option(
    '--min-quantile-samples <count>',
    'Minimum samples required for (uid, op_category) quantile without fallback',
    (value) => Number(value),
    30
  )
  .option('--budget-total <value>', 'Global probability budget Q_total', (value) => Number(value), 1e-2)
  .option(
    '--budget-weight-mode <mode>',
    'Weight mode for budget allocation (count|uniform)',
    (value) => String(value),
    'count'
  )
  .option('--spot-domain <value>', 'SPOT calibration domain (log_dt|z_deseas)', 'log_dt')
  .option('--spot-calib-count <value>', 'Initial record count for SPOT calibration', (value) => Number(value))
  .option('--spot-calib-start <value>', 'Inclusive ISO8601 start timestamp for SPOT calibration range')
  .option('--spot-calib-end <value>', 'Inclusive ISO8601 end timestamp for SPOT calibration range')
  .option(
    '--spot-p0 <values...>',
    'Candidate quantiles for SPOT baseline threshold',
    (values: string[]) => values.map((entry) => Number(entry)),
    ['0.90', '0.93', '0.95', '0.975', '0.99']
  )
  .option('--min-tail <count>', 'Minimum tail sample count', (value) => Number(value), 50)
  .option('--flag-tail-prob <value>', 'Tail probability threshold for flagging', (value) => Number(value), 1e-3)
  .option('--algo-ver <value>', 'Algorithm version identifier', '1.0.0')
  .option('--alpha <value>', 'Score combination coefficient', (value) => Number(value), 0.5)
  .option('--q <value>', 'Quantile target for control rules', (value) => Number(value), 0.99)
  .option('--calib-window <value>', 'Calibration window length', (value) => Number(value), 1000)
  .option('--decluster-r <value>', 'Declustering separation parameter', (value) => Number(value), 5)
  .option(
    '--kofn <values...>',
    'k-of-n voting parameters',
    (values: string[]) => values.map((entry) => Number(entry)),
    ['3', '5']
  )
  .option('--hysteresis-gamma <value>', 'Hysteresis gain (>1)', (value) => Number(value), 1.5)
  .option('--reestimate-every <value>', 'Re-estimation interval (events)', (value) => Number(value), 10000)
  .option('--min-exceed <value>', 'Minimum exceedances before alarm', (value) => Number(value), 5)
  .option('--pool-strategy <value>', 'Pooling strategy for group tail statistics', 'per-user')
  .option('--xi-eps <value>', 'Xi epsilon for stability', (value) => Number(value), 1e-3)
  .option('--upper-cap-per-day <value>', 'Upper cap per day', (value) => Number(value), 50)
  .option('--lower-clip <value>', 'Lower clip value', (value) => Number(value), -5)
  .option(
    '--seed <values...>',
    'Random seeds used in upstream stages',
    (values: string[]) => values.map((entry) => Number(entry)),
    ['0']
  )
  .requiredOption('--preproc-hash <value>', 'Preprocessing pipeline hash (SHA-256)')
    .action(async (cmdOpts) => {
      const quantiles = cmdOpts.quantile ? parseQuantileLevels(cmdOpts.quantile) : [0.9, 0.95, 0.99, 0.995];
      const seeds = (cmdOpts.seed as unknown[])
        .map((value) => Math.trunc(Number(value)))
        .filter((value) => Number.isFinite(value));
      if (seeds.length === 0) {
        throw new Error('At least one seed must be provided');
      }
      if (!Array.isArray(cmdOpts.kofn) || cmdOpts.kofn.length !== 2) {
        throw new Error('--kofn requires exactly two numeric values');
      }
      const kofnValues: [number, number] = [Math.trunc(Number(cmdOpts.kofn[0])), Math.trunc(Number(cmdOpts.kofn[1]))];
      if (kofnValues.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error('--kofn values must be positive integers');
      }
      const budgetWeightMode = String(cmdOpts.budgetWeightMode ?? 'count');
      if (budgetWeightMode !== 'count' && budgetWeightMode !== 'uniform') {
        throw new Error('--budget-weight-mode must be either count or uniform');
      }
      if (!(Number.isFinite(cmdOpts.hysteresisGamma) && cmdOpts.hysteresisGamma > 1)) {
        throw new Error('--hysteresis-gamma must be greater than 1');
      }
      const spotCandidates = Array.isArray(cmdOpts.spotP0)
        ? (cmdOpts.spotP0 as unknown[]).map((entry) => Number(entry))
        : [Number(cmdOpts.spotP0)];
      const result = await fitAnomalyModel({
        inputs: cmdOpts.input,
        statsOut: cmdOpts.statsOut,
        metaOut: cmdOpts.metaOut,
        baseColumn: cmdOpts.column,
        quantiles,
        quantileLower: cmdOpts.quantileLower,
        quantileUpper: cmdOpts.quantileUpper,
        minQuantileSamples: cmdOpts.minQuantileSamples,
        budgetTotal: Number(cmdOpts.budgetTotal ?? 1e-2),
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
  .option('--flag-tail-prob <value>', 'Override tail probability threshold', (value) => Number(value))
  .action(async (cmdOpts) => {
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
