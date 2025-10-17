import { z } from 'zod';

export const quantileEntrySchema = z.object({
  p: z.number().gt(0).lt(1),
  value: z.number()
});

export const quantileGroupEntrySchema = z.object({
  uid: z.string().min(1),
  op_category: z.string().min(1),
  tau_hi: z.number(),
  tau_lo: z.number(),
  n: z.number().int().min(0),
  method: z.literal('R7'),
  cdf: z.array(quantileEntrySchema).min(1)
});

const spotEstimatorSchema = z.enum(['mle', 'pwm', 'mom', 'quantile']);

export const spotGroupEntrySchema = z.object({
  uid: z.string().min(1),
  op_category: z.string().min(1),
  domain: z.enum(['log_dt', 'z_deseas']),
  u: z.number(),
  xi: z.number(),
  beta: z.number().positive(),
  p_ref: z.number().min(0),
  theta: z.number().gt(0),
  decluster_r: z.number().int().gte(0),
  calib_N: z.number().int().min(0),
  p0: z.number().gt(0).lt(1),
  q_star: z.number().gt(0).lte(1),
  estimator: spotEstimatorSchema,
  warnings: z.array(z.string().min(1)).optional().default([])
});

export const anomalyStatsSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().min(1),
  algo_ver: z.literal('5.0-spec'),
  base_column: z.string().min(1),
  quantile_levels: z.array(z.number().gt(0).lt(1)).min(1),
  global_quantiles: z.array(quantileEntrySchema).min(1),
  quantile: z.array(quantileGroupEntrySchema).min(1),
  spot: z.array(spotGroupEntrySchema).min(1)
});

export const budgetAllocationSchema = z.object({
  uid: z.string().min(1),
  op_category: z.string().min(1),
  weight: z.number().gte(0),
  q_alloc: z.number().gte(0)
});

export const budgetSchema = z.object({
  total: z.number().gt(0),
  weight_mode: z.enum(['count', 'uniform']),
  weight_sum: z.number().gte(0),
  allocations: z.array(budgetAllocationSchema).min(1)
});

export const anomalyMetaSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().min(1),
  stats_file: z.string().min(1),
  input_files: z.array(z.string().min(1)).min(1),
  row_count: z.number().int().min(0),
  base_column: z.string().min(1),
  quantile_levels: z.array(z.number().gt(0).lt(1)).min(1),
  spot: z.object({
    recalibrated: z.boolean(),
    min_tail_count: z.number().int().min(0),
    domain: z.enum(['log_dt', 'z_deseas']),
    xi_eps: z.number().gte(0),
    decluster_r: z.number().int().gte(0),
    initial_interval: z.object({
      type: z.enum(['count', 'range', 'all']),
      count: z.number().int().gte(1).optional(),
      start: z.string().optional(),
      end: z.string().optional()
    }),
    p0_candidates: z.array(z.number().gt(0).lt(1)).min(1)
  }),
  scoring: z.object({
    flag_tail_probability: z.number().gt(0).lte(1),
    score_column: z.string().min(1),
    base_mean: z.number(),
    base_std: z.number().gt(0)
  }),
  budget: budgetSchema,
  algo_ver: z.literal('5.0-spec'),
  alpha: z.number().gte(0),
  q: z.number().gt(0).lt(1),
  calib_window: z.number().int().gte(1),
  decluster_r: z.number().gte(0),
  kofn: z.tuple([z.number().int().gte(1), z.number().int().gte(1)]),
  H: z.number().gt(1),
  reestimate_every: z.number().int().gte(0),
  min_exceed: z.number().int().gte(0),
  pool_strategy: z.string().min(1),
  xi_eps: z.number().gte(0),
  'upper_cap/day': z.number().gte(0),
  lower_clip: z.number(),
  grouping: z.object({
    user: z.string().min(1),
    category: z.string().min(1)
  }),
  seeds: z.array(z.number().int()).min(1),
  stats_hash: z.string().regex(/^[a-f0-9]{64}$/),
  preproc_hash: z.string().min(1)
});

export type QuantileEntry = z.infer<typeof quantileEntrySchema>;
export type QuantileGroupEntry = z.infer<typeof quantileGroupEntrySchema>;
export type SpotGroupEntry = z.infer<typeof spotGroupEntrySchema>;
export type BudgetAllocation = z.infer<typeof budgetAllocationSchema>;
export type BudgetSpec = z.infer<typeof budgetSchema>;
export type AnomalyStats = z.infer<typeof anomalyStatsSchema>;
export type AnomalyMeta = z.infer<typeof anomalyMetaSchema>;
