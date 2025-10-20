import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'fast-csv';

import { scoreStream } from '../src/score.js';

export interface ScoreRow {
  readonly dt: number;
  readonly log_dt: number;
  readonly alarm: number;
  readonly spot_tau_t: number;
  readonly neglog10_p: number;
}

export interface SpotScenarioOptions {
  readonly qStar: number;
  readonly dtValues: readonly number[];
  readonly xi?: number;
  readonly beta?: number;
  readonly pRef?: number;
  readonly hysteresisH?: number;
  readonly kofn?: readonly [number, number];
}

export interface SpotScenarioResult {
  readonly flagged: number;
  readonly rows: readonly ScoreRow[];
  readonly cleanup: () => Promise<void>;
}

async function readScoreRows(path: string): Promise<ScoreRow[]> {
  const rows: ScoreRow[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .pipe(parse({ headers: true, trim: true }))
      .on('error', reject)
      .on('data', (row: Record<string, string>) => {
        rows.push({
          dt: Number(row.dt),
          log_dt: Number(row.log_dt),
          alarm: Number(row.alarm),
          spot_tau_t: Number(row.spot_tau_t),
          neglog10_p: Number(row.neglog10_p)
        });
      })
      .on('end', () => resolve());
  });
  return rows;
}

export async function runSpotScenario(options: SpotScenarioOptions): Promise<SpotScenarioResult> {
  const dir = await mkdtemp(join(tmpdir(), 'spot-scenario-'));
  const inputPath = join(dir, 'input.csv');
  const statsPath = join(dir, 'stats.json');
  const metaPath = join(dir, 'meta.json');
  const outputPath = join(dir, 'output.csv');
  const auditPath = join(dir, 'audit.csv');

  const csvLines = ['uid,op_category,dt,log_dt,z_deseas'];
  for (const value of options.dtValues) {
    csvLines.push(`user1,READ,${value},${Math.log(value)},0`);
  }
  await writeFile(inputPath, `${csvLines.join('\n')}\n`, 'utf8');

  const spotEntry = {
    uid: 'user1',
    op_category: 'READ',
    domain: 'log_dt' as const,
    u: Math.log(5),
    xi: options.xi ?? 0.2,
    beta: options.beta ?? 0.7,
    p_ref: options.pRef ?? 0.01,
    theta: 0.85,
    decluster_r: 0,
    calib_N: 120,
    p0: 0.02,
    q_star: options.qStar,
    estimator: 'mle' as const,
    warnings: [] as string[]
  };

  const stats = {
    version: 1,
    generated_at: '2024-01-01T00:00:00Z',
    algo_ver: '5.0-spec' as const,
    base_column: 'dt',
    quantile_levels: [0.95],
    global_quantiles: [{ p: 0.95, value: 25 }],
    quantile: [
      {
        uid: '__global__',
        op_category: '__global__',
        tau_hi: 50,
        tau_lo: 0.5,
        n: 100,
        method: 'R7' as const,
        cdf: [
          { p: 0.5, value: 5 },
          { p: 0.95, value: 20 }
        ]
      },
      {
        uid: 'user1',
        op_category: '__all__',
        tau_hi: 50,
        tau_lo: 0.5,
        n: 100,
        method: 'R7' as const,
        cdf: [
          { p: 0.5, value: 5 },
          { p: 0.95, value: 20 }
        ]
      },
      {
        uid: 'user1',
        op_category: 'READ',
        tau_hi: 50,
        tau_lo: 0.5,
        n: 100,
        method: 'R7' as const,
        cdf: [
          { p: 0.5, value: 5 },
          { p: 0.95, value: 20 }
        ]
      }
    ],
    spot: [
      {
        uid: '__global__',
        op_category: '__global__',
        domain: 'log_dt' as const,
        u: Math.log(5),
        xi: options.xi ?? 0.2,
        beta: options.beta ?? 0.7,
        p_ref: options.pRef ?? 0.01,
        theta: 0.85,
        decluster_r: 0,
        calib_N: 120,
        p0: 0.02,
        q_star: options.qStar,
        estimator: 'mle' as const,
        warnings: [] as string[]
      },
      {
        uid: 'user1',
        op_category: '__all__',
        domain: 'log_dt' as const,
        u: Math.log(5),
        xi: options.xi ?? 0.2,
        beta: options.beta ?? 0.7,
        p_ref: options.pRef ?? 0.01,
        theta: 0.85,
        decluster_r: 0,
        calib_N: 120,
        p0: 0.02,
        q_star: options.qStar,
        estimator: 'mle' as const,
        warnings: [] as string[]
      },
      spotEntry
    ]
  };

  const [kVotes, windowSize] = options.kofn ?? [1, 1];

  const meta = {
    version: 1,
    generated_at: '2024-01-01T00:00:00Z',
    stats_file: statsPath,
    input_files: [inputPath],
    row_count: options.dtValues.length,
    base_column: 'dt',
    quantile_levels: [0.95],
    spot: {
      recalibrated: false,
      min_tail_count: 1,
      domain: 'log_dt' as const,
      xi_eps: 1e-9,
      decluster_r: 0,
      initial_interval: { type: 'all' as const },
      p0_candidates: [spotEntry.p0]
    },
    scoring: {
      flag_tail_probability: 0.01,
      score_column: 'neglog10_p',
      base_mean: 0,
      base_std: 1
    },
    budget: {
      total: 1,
      weight_mode: 'uniform' as const,
      weight_sum: 1,
      allocations: [
        {
          uid: 'user1',
          op_category: 'READ',
          weight: 1,
          q_alloc: 1
        }
      ]
    },
    algo_ver: '5.0-spec' as const,
    alpha: 0.01,
    q: 0.02,
    calib_window: 10,
    decluster_r: 0,
    kofn: [kVotes, windowSize] as const,
    H: options.hysteresisH ?? 1.1,
    reestimate_every: 100,
    min_exceed: 1,
    pool_strategy: 'global',
    xi_eps: 1e-9,
    'upper_cap/day': 100,
    lower_clip: 0,
    grouping: {
      user: 'uid',
      category: 'op_category'
    },
    seeds: [1],
    stats_hash: '0'.repeat(64),
    preproc_hash: 'spec-tests',
    threshold_tiers: {
      quantile: [
        {
          uid: '__global__',
          op_category: '__global__',
          tier: 'global' as const,
          sample_count: 0,
          source_uid: '__global__',
          source_op_category: '__global__'
        }
      ],
      spot: [
        {
          uid: '__global__',
          op_category: '__global__',
          tier: 'global' as const,
          sample_count: 0,
          source_uid: '__global__',
          source_op_category: '__global__'
        }
      ]
    }
  };

  await writeFile(statsPath, JSON.stringify(stats, null, 2), 'utf8');
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  const summary = await scoreStream({
    input: inputPath,
    output: outputPath,
    statsPath,
    metaPath,
    auditPath
  });

  const rows = await readScoreRows(outputPath);
  return {
    flagged: summary.flaggedRows,
    rows,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}
