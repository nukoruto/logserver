import { computeQuantiles, ensureSorted } from './quantile.js';
import type { QuantileSummary } from './quantile.js';
import {
  calibrateSpot,
  type SpotCalibrateOptions,
  type SpotCalibrateResult,
  type SpotSample,
  type SpotEstimatorType
} from './spot.js';
import { loadDtRecords, writeJsonFile } from './io.js';
import {
  anomalyStatsSchema,
  anomalyMetaV2Schema,
  type AnomalyStats,
  type AnomalyMetaV2,
  type QuantileGroupEntry,
  type ThresholdTierEntry
} from './schema.js';
import { nowIso, parseQuantileLevels, computeHashHex } from './utils.js';
import { createRunningMoments, finalizeStd, updateRunningMoments } from './utils.js';

const ALGO_VERSION = '5.0-spec';

type BudgetWeightMode = 'count' | 'uniform';

type TierScope = 'group' | 'user' | 'global';

export interface FitOptions {
  readonly inputs: readonly string[];
  readonly statsOut: string;
  readonly metaOut: string;
  readonly baseColumn: string;
  readonly quantiles: readonly number[];
  readonly quantileLower: number;
  readonly quantileUpper: number;
  readonly minQuantileSamples: number;
  readonly budgetTotal: number;
  readonly budgetWeightMode: BudgetWeightMode;
  readonly spotDomain: 'log_dt' | 'z_deseas';
  readonly spotCalibCount?: number;
  readonly spotCalibStart?: string;
  readonly spotCalibEnd?: string;
  readonly spotQuantileCandidates: readonly number[];
  readonly minTailCount: number;
  readonly flagTailProbability: number;
  readonly alpha: number;
  readonly q: number;
  readonly calibWindow: number;
  readonly declusterR: number;
  readonly kofn: readonly [number, number];
  readonly H: number;
  readonly reestimateEvery: number;
  readonly minExceed: number;
  readonly poolStrategy: string;
  readonly xiEps: number;
  readonly upperCapPerDay: number;
  readonly lowerClip: number;
  readonly seeds: readonly number[];
  readonly preprocHash: string;
}

export interface FitResult {
  readonly stats: AnomalyStats;
  readonly meta: AnomalyMetaV2;
}

interface InitialIntervalMeta {
  readonly type: 'count' | 'range' | 'all';
  readonly count?: number;
  readonly start?: string;
  readonly end?: string;
}

function buildSpotSamples(records: readonly {
  readonly index: number;
  readonly value: number;
}[]): SpotSample[] {
  return records.map((record) => ({ value: record.value, index: record.index }));
}

function extractDiagnostics(
  result: SpotCalibrateResult,
  extraWarnings: readonly string[] = []
): { estimator: SpotEstimatorType; warnings: string[] } {
  const diagnostics = result.diagnostics ?? { estimator: 'mle' as SpotEstimatorType, warnings: [], fallbackUsed: false };
  const combined = [...(diagnostics.warnings ?? []), ...extraWarnings].filter((warning) => warning.length > 0);
  const unique = Array.from(new Set(combined));
  return { estimator: diagnostics.estimator, warnings: unique };
}

export async function fitAnomalyModel(options: FitOptions): Promise<FitResult> {
  if (options.inputs.length === 0) {
    throw new Error('No input files provided');
  }
  if (!(options.quantileLower > 0 && options.quantileLower < 1)) {
    throw new Error('quantileLower must be between 0 and 1');
  }
  if (!(options.quantileUpper > 0 && options.quantileUpper < 1)) {
    throw new Error('quantileUpper must be between 0 and 1');
  }
  if (options.quantileLower >= options.quantileUpper) {
    throw new Error('quantileLower must be less than quantileUpper');
  }
  if (options.seeds.length === 0) {
    throw new Error('At least one seed must be provided');
  }
  if (options.seeds.some((value) => !Number.isFinite(value))) {
    throw new Error('seeds must be finite numbers');
  }
  if (!options.preprocHash || options.preprocHash.length === 0) {
    throw new Error('preprocHash must be provided');
  }
  if (!Number.isFinite(options.minQuantileSamples) || options.minQuantileSamples <= 0) {
    throw new Error('minQuantileSamples must be a positive number');
  }
  if (!Number.isFinite(options.budgetTotal) || options.budgetTotal <= 0) {
    throw new Error('budgetTotal must be a positive number');
  }
  if (options.budgetWeightMode !== 'count' && options.budgetWeightMode !== 'uniform') {
    throw new Error('budgetWeightMode must be either count or uniform');
  }
  if (options.spotDomain !== 'log_dt' && options.spotDomain !== 'z_deseas') {
    throw new Error('spotDomain must be log_dt or z_deseas');
  }
  if (!Number.isFinite(options.H) || options.H <= 1) {
    throw new Error('H must be greater than 1');
  }
  if (options.spotCalibStart || options.spotCalibEnd) {
    if (!options.spotCalibStart || !options.spotCalibEnd) {
      throw new Error('Both spotCalibStart and spotCalibEnd are required when specifying a range');
    }
    const startMs = Date.parse(options.spotCalibStart);
    const endMs = Date.parse(options.spotCalibEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error('Invalid SPOT calibration range');
    }
  }
  if (options.spotCalibCount !== undefined && (!Number.isFinite(options.spotCalibCount) || options.spotCalibCount <= 0)) {
    throw new Error('spotCalibCount must be a positive number when provided');
  }
  const candidateQuantiles = Array.from(new Set(options.spotQuantileCandidates.filter((value) => value > 0 && value < 1))).sort(
    (a, b) => a - b
  );
  if (candidateQuantiles.length === 0) {
    throw new Error('At least one valid SPOT quantile candidate must be provided');
  }
  const load = await loadDtRecords(options.inputs, {
    dtColumn: options.baseColumn,
    logDtColumn: 'log_dt',
    zDeseasColumn: 'z_deseas'
  });
  if (load.records.length === 0) {
    throw new Error(`Column '${options.baseColumn}' had no numeric samples`);
  }
  const records = load.records;
  const allDtValues = records.map((sample) => sample.dt);
  const sortedDtValues = ensureSorted(allDtValues);
  const quantileLevels = parseQuantileLevels([...options.quantiles, options.quantileLower, options.quantileUpper]);
  const globalQuantiles = computeQuantiles(sortedDtValues, quantileLevels);
  const groupDtValues = new Map<string, number[]>();
  const userDtValues = new Map<string, number[]>();
  for (const sample of records) {
    const groupKey = `${sample.uid}||${sample.opCategory}`;
    const groupList = groupDtValues.get(groupKey);
    if (groupList === undefined) {
      groupDtValues.set(groupKey, [sample.dt]);
    } else {
      groupList.push(sample.dt);
    }
    const userList = userDtValues.get(sample.uid);
    if (userList === undefined) {
      userDtValues.set(sample.uid, [sample.dt]);
    } else {
      userList.push(sample.dt);
    }
  }
  const sortedGroupDtValues = new Map<string, number[]>();
  for (const [key, values] of groupDtValues.entries()) {
    sortedGroupDtValues.set(key, ensureSorted(values));
  }
  const sortedUserDtValues = new Map<string, number[]>();
  for (const [uid, values] of userDtValues.entries()) {
    sortedUserDtValues.set(uid, ensureSorted(values));
  }
  function findQuantileValue(entries: readonly QuantileSummary[], targetP: number): number {
    if (entries.length === 0) {
      throw new Error('Quantile entries required to compute target value');
    }
    let bestValue = entries[0].value;
    let bestDiff = Math.abs(entries[0].p - targetP);
    for (const entry of entries) {
      const diff = Math.abs(entry.p - targetP);
      if (diff < 1e-9) {
        return entry.value;
      }
      if (diff < bestDiff) {
        bestDiff = diff;
        bestValue = entry.value;
      }
    }
    return bestValue;
  }
  const quantileDatasetCache = new Map<string, {
    cdf: QuantileSummary[];
    tauHi: number;
    tauLo: number;
    sampleCount: number;
  }>();
  function getQuantileDatasetStats(cacheKey: string, values: readonly number[]): {
    cdf: QuantileSummary[];
    tauHi: number;
    tauLo: number;
    sampleCount: number;
  } {
    const existing = quantileDatasetCache.get(cacheKey);
    if (existing) {
      return existing;
    }
    const cdf = computeQuantiles(values, quantileLevels);
    const tauHi = findQuantileValue(cdf, options.quantileUpper);
    const tauLo = findQuantileValue(cdf, options.quantileLower);
    const result = { cdf, tauHi, tauLo, sampleCount: values.length };
    quantileDatasetCache.set(cacheKey, result);
    return result;
  }
  const quantileTierRecords: ThresholdTierEntry[] = [];
  function resolveTierSource(scope: TierScope, targetUid: string, targetOpCategory: string) {
    if (scope === 'group') {
      return { sourceUid: targetUid, sourceOpCategory: targetOpCategory };
    }
    if (scope === 'user') {
      return { sourceUid: targetUid, sourceOpCategory: '__all__' };
    }
    return { sourceUid: '__global__', sourceOpCategory: '__global__' };
  }
  function createQuantileEntry(params: {
    scope: TierScope;
    key: string;
    uid: string;
    opCategory: string;
    values: readonly number[];
  }): { entry: QuantileGroupEntry; datasetKey: string } {
    const cacheKey = `${params.scope}:${params.key}`;
    const statsForDataset = getQuantileDatasetStats(cacheKey, params.values);
    const tierSource = resolveTierSource(params.scope, params.uid, params.opCategory);
    quantileTierRecords.push({
      uid: params.uid,
      op_category: params.opCategory,
      tier: params.scope,
      sample_count: statsForDataset.sampleCount,
      source_uid: tierSource.sourceUid,
      source_op_category: tierSource.sourceOpCategory
    });
    return {
      entry: {
        uid: params.uid,
        op_category: params.opCategory,
        tau_hi: statsForDataset.tauHi,
        tau_lo: statsForDataset.tauLo,
        n: statsForDataset.sampleCount,
        method: 'R7',
        cdf: statsForDataset.cdf
      },
      datasetKey: cacheKey
    };
  }
  const quantileEntriesWithMeta: { entry: QuantileGroupEntry; datasetKey: string }[] = [];
  for (const [groupKey] of sortedGroupDtValues.entries()) {
    const [uid, opCategory] = groupKey.split('||', 2);
    const groupValues = sortedGroupDtValues.get(groupKey);
    const userValues = sortedUserDtValues.get(uid);
    if (groupValues && groupValues.length >= options.minQuantileSamples) {
      quantileEntriesWithMeta.push(
        createQuantileEntry({ scope: 'group', key: groupKey, uid, opCategory, values: groupValues })
      );
    } else if (userValues && userValues.length >= options.minQuantileSamples) {
      quantileEntriesWithMeta.push(
        createQuantileEntry({ scope: 'user', key: uid, uid, opCategory, values: userValues })
      );
    } else {
      quantileEntriesWithMeta.push(
        createQuantileEntry({ scope: 'global', key: '__global__', uid, opCategory, values: sortedDtValues })
      );
    }
  }
  for (const [uid, values] of sortedUserDtValues.entries()) {
    quantileEntriesWithMeta.push(
      createQuantileEntry({ scope: 'user', key: uid, uid, opCategory: '__all__', values })
    );
  }
  quantileEntriesWithMeta.push(
    createQuantileEntry({ scope: 'global', key: '__global__', uid: '__global__', opCategory: '__global__', values: sortedDtValues })
  );
  quantileEntriesWithMeta.sort((a, b) => {
    const uidCompare = a.entry.uid.localeCompare(b.entry.uid);
    if (uidCompare !== 0) {
      return uidCompare;
    }
    return a.entry.op_category.localeCompare(b.entry.op_category);
  });
  const quantileEntries: QuantileGroupEntry[] = quantileEntriesWithMeta.map((item) => item.entry);
  const baseWeights = quantileEntriesWithMeta.map((item) => {
    const datasetStats = quantileDatasetCache.get(item.datasetKey);
    const rawWeight = options.budgetWeightMode === 'count' ? datasetStats?.sampleCount ?? 0 : 1;
    return Math.max(rawWeight, 0);
  });
  let weightSum = baseWeights.reduce((acc, value) => acc + value, 0);
  if (weightSum <= 0 && baseWeights.length > 0) {
    for (let i = 0; i < baseWeights.length; i += 1) {
      baseWeights[i] = 1;
    }
    weightSum = baseWeights.length;
  }
  const budgetAllocations = quantileEntriesWithMeta.map((item, index) => {
    const weight = baseWeights[index];
    const qAlloc = weightSum > 0 ? (weight / weightSum) * options.budgetTotal : options.budgetTotal;
    return {
      uid: item.entry.uid,
      op_category: item.entry.op_category,
      weight,
      q_alloc: qAlloc
    };
  });
  let calibrationRecords = [...records];
  let initialIntervalMeta: InitialIntervalMeta = { type: 'all' };
  if (options.spotCalibStart && options.spotCalibEnd) {
    const startMs = Date.parse(options.spotCalibStart);
    const endMs = Date.parse(options.spotCalibEnd);
    calibrationRecords = records
      .filter((record) => {
        if (!record.timestampUtc) {
          return false;
        }
        const ts = Date.parse(record.timestampUtc);
        return Number.isFinite(ts) && ts >= startMs && ts <= endMs;
      })
      .sort((a, b) => a.index - b.index);
    if (calibrationRecords.length === 0) {
      throw new Error('No records found in specified SPOT calibration range');
    }
    initialIntervalMeta = { type: 'range', start: options.spotCalibStart, end: options.spotCalibEnd };
  } else if (options.spotCalibCount !== undefined) {
    const sortedByIndex = [...records].sort((a, b) => a.index - b.index);
    calibrationRecords = sortedByIndex.slice(0, Math.min(sortedByIndex.length, Math.trunc(options.spotCalibCount)));
    if (calibrationRecords.length === 0) {
      throw new Error('No records available for SPOT calibration count');
    }
    initialIntervalMeta = { type: 'count', count: calibrationRecords.length };
  }
  const domainGroupSamples = new Map<string, SpotSample[]>();
  const domainUserSamples = new Map<string, SpotSample[]>();
  const globalDomainRecords: { value: number; index: number }[] = [];
  for (const record of calibrationRecords) {
    const domainValue = options.spotDomain === 'log_dt' ? record.logDt : record.zDeseas;
    if (domainValue === undefined || !Number.isFinite(domainValue)) {
      continue;
    }
    globalDomainRecords.push({ value: domainValue, index: record.index });
    const groupKey = `${record.uid}||${record.opCategory}`;
    const groupList = domainGroupSamples.get(groupKey);
    const sample = { value: domainValue, index: record.index };
    if (groupList === undefined) {
      domainGroupSamples.set(groupKey, [sample]);
    } else {
      groupList.push(sample);
    }
    const userList = domainUserSamples.get(record.uid);
    if (userList === undefined) {
      domainUserSamples.set(record.uid, [sample]);
    } else {
      userList.push(sample);
    }
  }
  if (globalDomainRecords.length < options.minTailCount) {
    throw new Error('Insufficient samples for global SPOT calibration');
  }
  const spotOptions: SpotCalibrateOptions = {
    minTailCount: options.minTailCount,
    xiEps: options.xiEps,
    declusterR: options.declusterR,
    q: options.q
  };
  const spotEntries: AnomalyStats['spot'] = [];
  const spotTierRecords: ThresholdTierEntry[] = [];
  const globalSpotResult = calibrateSpot(buildSpotSamples(globalDomainRecords), candidateQuantiles, spotOptions);
  const userSpotCache = new Map<string, SpotCalibrateResult>();
  const globalDiag = extractDiagnostics(globalSpotResult);
  spotEntries.push({
    uid: '__global__',
    op_category: '__global__',
    domain: options.spotDomain,
    u: globalSpotResult.threshold,
    xi: globalSpotResult.xi,
    beta: globalSpotResult.beta,
    p_ref: globalSpotResult.pRef,
    theta: globalSpotResult.theta,
    decluster_r: options.declusterR,
    calib_N: globalSpotResult.calibrationSize,
    p0: globalSpotResult.quantile,
    q_star: globalSpotResult.qStar,
    estimator: globalDiag.estimator,
    warnings: globalDiag.warnings
  });
  spotTierRecords.push({
    uid: '__global__',
    op_category: '__global__',
    tier: 'global',
    sample_count: globalSpotResult.calibrationSize,
    source_uid: '__global__',
    source_op_category: '__global__'
  });
  for (const [uid, samples] of domainUserSamples.entries()) {
    let result: SpotCalibrateResult;
    const extraWarnings: string[] = [];
    let tierUsed: TierScope = 'user';
    try {
      result = calibrateSpot(samples, candidateQuantiles, spotOptions);
    } catch (error) {
      result = globalSpotResult;
      extraWarnings.push('user_spot_fallback_global');
      tierUsed = 'global';
      if (error instanceof Error && error.message) {
        extraWarnings.push(`user_spot_error:${error.message}`);
      } else {
        extraWarnings.push('user_spot_error');
      }
    }
    userSpotCache.set(uid, result);
    const diag = extractDiagnostics(result, extraWarnings);
    spotEntries.push({
      uid,
      op_category: '__all__',
      domain: options.spotDomain,
      u: result.threshold,
      xi: result.xi,
      beta: result.beta,
      p_ref: result.pRef,
      theta: result.theta,
      decluster_r: options.declusterR,
      calib_N: result.calibrationSize,
      p0: result.quantile,
      q_star: result.qStar,
      estimator: diag.estimator,
      warnings: diag.warnings
    });
    const source = tierUsed === 'global'
      ? { sourceUid: '__global__', sourceOpCategory: '__global__' }
      : { sourceUid: uid, sourceOpCategory: '__all__' };
    spotTierRecords.push({
      uid,
      op_category: '__all__',
      tier: tierUsed,
      sample_count: result.calibrationSize,
      source_uid: source.sourceUid,
      source_op_category: source.sourceOpCategory
    });
  }
  const groupKeys = new Set<string>();
  for (const key of domainGroupSamples.keys()) {
    groupKeys.add(key);
  }
  for (const key of sortedGroupDtValues.keys()) {
    groupKeys.add(key);
  }
  for (const groupKey of groupKeys) {
    const samples = domainGroupSamples.get(groupKey);
    const [uid, opCategory] = groupKey.split('||', 2);
    let result: SpotCalibrateResult | undefined;
    const fallbackWarnings: string[] = [];
    let tierUsed: TierScope = 'group';
    if (samples && samples.length >= options.minTailCount) {
      try {
        result = calibrateSpot(samples, candidateQuantiles, spotOptions);
      } catch (error) {
        result = undefined;
        fallbackWarnings.push('group_spot_error');
        if (error instanceof Error && error.message) {
          fallbackWarnings.push(`group_spot_error_detail:${error.message}`);
        }
      }
    } else {
      fallbackWarnings.push('group_spot_insufficient_samples');
    }
    if (!result) {
      const cached = userSpotCache.get(uid);
      if (cached) {
        fallbackWarnings.push('group_spot_fallback_user');
        result = cached;
        tierUsed = cached === globalSpotResult ? 'global' : 'user';
      } else {
        fallbackWarnings.push('group_spot_fallback_global');
        result = globalSpotResult;
        tierUsed = 'global';
      }
    }
    const diag = extractDiagnostics(result, fallbackWarnings);
    spotEntries.push({
      uid,
      op_category: opCategory,
      domain: options.spotDomain,
      u: result.threshold,
      xi: result.xi,
      beta: result.beta,
      p_ref: result.pRef,
      theta: result.theta,
      decluster_r: options.declusterR,
      calib_N: result.calibrationSize,
      p0: result.quantile,
      q_star: result.qStar,
      estimator: diag.estimator,
      warnings: diag.warnings
    });
    let sourceUid = uid;
    let sourceOpCategory = opCategory;
    if (tierUsed === 'user') {
      sourceOpCategory = '__all__';
    } else if (tierUsed === 'global') {
      sourceUid = '__global__';
      sourceOpCategory = '__global__';
    }
    spotTierRecords.push({
      uid,
      op_category: opCategory,
      tier: tierUsed,
      sample_count: result.calibrationSize,
      source_uid: sourceUid,
      source_op_category: sourceOpCategory
    });
  }
  spotEntries.sort((a, b) => {
    const uidCompare = a.uid.localeCompare(b.uid);
    if (uidCompare !== 0) {
      return uidCompare;
    }
    return a.op_category.localeCompare(b.op_category);
  });
  const baseMoments = createRunningMoments();
  let runningBase = baseMoments;
  for (const value of sortedDtValues) {
    runningBase = updateRunningMoments(runningBase, value);
  }
  const baseMean = runningBase.mean;
  const baseStd = Math.max(finalizeStd(runningBase), 1e-9);
  const stats: AnomalyStats = anomalyStatsSchema.parse({
    version: 1,
    generated_at: nowIso(),
    algo_ver: ALGO_VERSION,
    base_column: options.baseColumn,
    quantile_levels: quantileLevels,
    global_quantiles: globalQuantiles,
    quantile: quantileEntries,
    spot: spotEntries
  });
  await writeJsonFile(options.statsOut, stats);
  const statsHash = computeHashHex(JSON.stringify(stats));
  const seedsNormalized = options.seeds.map((value) => Math.trunc(value));
  const meta: AnomalyMetaV2 = anomalyMetaV2Schema.parse({
    version: 2,
    generated_at: nowIso(),
    stats_file: options.statsOut,
    input_files: Array.from(options.inputs),
    row_count: load.rowCount,
    base_column: options.baseColumn,
    quantile_levels: quantileLevels,
    spot: {
      recalibrated: false,
      min_tail_count: options.minTailCount,
      domain: options.spotDomain,
      xi_eps: options.xiEps,
      decluster_r: options.declusterR,
      initial_interval: initialIntervalMeta,
      p0_candidates: candidateQuantiles
    },
    scoring: {
      flag_tail_probability: options.flagTailProbability,
      score_column: options.baseColumn,
      base_mean: baseMean,
      base_std: baseStd
    },
    budget: {
      total: options.budgetTotal,
      weight_mode: options.budgetWeightMode,
      weight_sum: weightSum,
      allocations: budgetAllocations
    },
    algo_ver: ALGO_VERSION,
    alpha: options.alpha,
    q: options.q,
    calib_window: options.calibWindow,
    decluster_r: options.declusterR,
    kofn: [options.kofn[0], options.kofn[1]],
    H: options.H,
    reestimate_every: options.reestimateEvery,
    min_exceed: options.minExceed,
    pool_strategy: options.poolStrategy,
    xi_eps: options.xiEps,
    'upper_cap/day': options.upperCapPerDay,
    lower_clip: options.lowerClip,
    grouping: {
      user: 'uid',
      category: 'op_category'
    },
    seeds: seedsNormalized,
    stats_hash: statsHash,
    preproc_hash: options.preprocHash,
    threshold_tiers: {
      quantile: [...quantileTierRecords].sort((a, b) => {
        const uidCompare = a.uid.localeCompare(b.uid);
        if (uidCompare !== 0) {
          return uidCompare;
        }
        const catCompare = a.op_category.localeCompare(b.op_category);
        if (catCompare !== 0) {
          return catCompare;
        }
        if (a.tier === b.tier) {
          return 0;
        }
        return a.tier < b.tier ? -1 : 1;
      }),
      spot: [...spotTierRecords].sort((a, b) => {
        const uidCompare = a.uid.localeCompare(b.uid);
        if (uidCompare !== 0) {
          return uidCompare;
        }
        const catCompare = a.op_category.localeCompare(b.op_category);
        if (catCompare !== 0) {
          return catCompare;
        }
        if (a.tier === b.tier) {
          return 0;
        }
        return a.tier < b.tier ? -1 : 1;
      })
    }
  });
  await writeJsonFile(options.metaOut, meta);
  return { stats, meta };
}
