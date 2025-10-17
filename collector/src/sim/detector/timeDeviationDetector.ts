import type { SimulationEvent } from '../../services/simulationService';

type ThresholdTier = 'group' | 'user' | 'global';

interface ThresholdResolution {
  threshold: number;
  tier: ThresholdTier;
  sampleCount: number;
}

export interface TimeDeviationThresholdSummary {
  tier_usage: Record<ThresholdTier, number>;
  sample_counts: {
    global: number;
    per_user: Record<string, number>;
    per_group: Record<string, number>;
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeId = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class TimeDeviationThresholdCache {
  private readonly groupSamples = new Map<string, number[]>();

  private readonly userSamples = new Map<string, number[]>();

  private readonly globalSamples: number[] = [];

  private readonly tierUsage: Record<ThresholdTier, number> = { group: 0, user: 0, global: 0 };

  private getGroupKey(uid: string, opCategory: string): string {
    return `${uid}||${opCategory}`;
  }

  private resolveSamples(map: Map<string, number[]>, key: string): number[] {
    const existing = map.get(key);
    if (existing) {
      return existing;
    }
    const created: number[] = [];
    map.set(key, created);
    return created;
  }

  record(uid: string | null, opCategory: string | null, deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      return;
    }
    this.globalSamples.push(deltaSeconds);
    if (!uid) {
      return;
    }
    const userSamples = this.resolveSamples(this.userSamples, uid);
    userSamples.push(deltaSeconds);
    if (!opCategory) {
      return;
    }
    const groupKey = this.getGroupKey(uid, opCategory);
    const groupSamples = this.resolveSamples(this.groupSamples, groupKey);
    groupSamples.push(deltaSeconds);
  }

  private resolveDataset(
    uid: string | null,
    opCategory: string | null,
    minSamples: number,
  ): { values: readonly number[]; tier: ThresholdTier } {
    if (uid && opCategory) {
      const groupKey = this.getGroupKey(uid, opCategory);
      const groupSamples = this.groupSamples.get(groupKey) ?? [];
      if (groupSamples.length >= minSamples) {
        return { values: groupSamples, tier: 'group' };
      }
    }
    if (uid) {
      const userSamples = this.userSamples.get(uid) ?? [];
      if (userSamples.length >= minSamples) {
        return { values: userSamples, tier: 'user' };
      }
    }
    return { values: this.globalSamples, tier: 'global' };
  }

  resolve(uid: string | null, opCategory: string | null, options: Required<Pick<TimeDeviationOptions, 'minSamples' | 'quantile' | 'fallbackThresholdSeconds' | 'method'>>): ThresholdResolution {
    const minSamples = Number.isInteger(options.minSamples) && (options.minSamples as number) > 0
      ? (options.minSamples as number)
      : DEFAULT_OPTIONS.minSamples;
    const dataset = this.resolveDataset(uid, opCategory, minSamples);
    let threshold = resolveThreshold(dataset.values, options);
    if (!Number.isFinite(threshold) || threshold < 0) {
      const fallback = options.fallbackThresholdSeconds;
      const fallbackNumeric = fallback === null || fallback === undefined ? Number.NaN : Number(fallback);
      if (Number.isFinite(fallbackNumeric) && fallbackNumeric >= 0) {
        threshold = fallbackNumeric;
      } else {
        threshold = 0;
      }
    }
    this.tierUsage[dataset.tier] += 1;
    return {
      threshold,
      tier: dataset.tier,
      sampleCount: dataset.values.length,
    };
  }

  seedGlobal(values: readonly number[]): void {
    for (const value of values) {
      if (Number.isFinite(value) && value > 0) {
        this.globalSamples.push(value);
      }
    }
  }

  summary(): TimeDeviationThresholdSummary {
    const perUser = Object.fromEntries(
      Array.from(this.userSamples.entries()).map(([uid, samples]) => [uid, samples.length]),
    );
    const perGroup = Object.fromEntries(
      Array.from(this.groupSamples.entries()).map(([key, samples]) => [key, samples.length]),
    );
    return {
      tier_usage: { ...this.tierUsage },
      sample_counts: {
        global: this.globalSamples.length,
        per_user: perUser,
        per_group: perGroup,
      },
    };
  }
}

export const createThresholdCache = (): TimeDeviationThresholdCache => new TimeDeviationThresholdCache();

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | string;
  quantile?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
  statsCache?: TimeDeviationThresholdCache;
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationFlag?: boolean;
  timeDeviationThresholdTier?: ThresholdTier;
  timeDeviationSampleCount?: number;
}

const DEFAULT_OPTIONS: Required<Pick<TimeDeviationOptions, 'method' | 'quantile' | 'minSamples' | 'fallbackThresholdSeconds'>> = {
  method: 'quantile',
  quantile: 0.99,
  minSamples: 5,
  fallbackThresholdSeconds: null,
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseTimestamp = (value: unknown): Date | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

const resolveDeltaSeconds = (
  current: SimulationEvent | null | undefined,
  previous: SimulationEvent | null | undefined,
): number | null => {
  if (!current) {
    return null;
  }
  const declared = Number((current as Record<string, unknown>).deltaSeconds);
  if (isFiniteNumber(declared) && declared >= 0) {
    return declared;
  }
  if (!previous) {
    return null;
  }
  const currentTimestamp = parseTimestamp((current as Record<string, unknown>).timestamp);
  const previousTimestamp = parseTimestamp((previous as Record<string, unknown>).timestamp);
  if (currentTimestamp && previousTimestamp) {
    return Math.max(0, (currentTimestamp.getTime() - previousTimestamp.getTime()) / 1000);
  }
  return null;
};

export const extractDeltaSeries = (sequence: readonly SimulationEvent[]): number[] => {
  if (!Array.isArray(sequence)) {
    return [];
  }
  const deltas: number[] = [];
  for (let index = 1; index < sequence.length; index += 1) {
    const delta = resolveDeltaSeconds(sequence[index], sequence[index - 1]);
    if (isFiniteNumber(delta)) {
      deltas.push(delta);
    }
  }
  return deltas;
};

const computeQuantile = (values: readonly number[], quantile: number): number => {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }
  const clampedQuantile = Math.min(Math.max(quantile, 0), 1);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const position = (sorted.length - 1) * clampedQuantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
};

export const resolveThreshold = (
  values: readonly number[],
  options: TimeDeviationOptions,
): number => {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }
  const methodRaw = options.method;
  const method = typeof methodRaw === 'string' ? methodRaw.toLowerCase() : DEFAULT_OPTIONS.method;
  if (method === 'fixed') {
    const fixed = Number(options.thresholdSeconds);
    return isFiniteNumber(fixed) ? fixed : Number.NaN;
  }
  if (method === 'spot') {
    // TODO: Implement SPOT (Peaks Over Threshold) method.
    // Fallback to quantile-based threshold for initial implementation.
  }
  const quantileValue = Number(options.quantile);
  const targetQuantile = isFiniteNumber(quantileValue) ? quantileValue : DEFAULT_OPTIONS.quantile;
  return computeQuantile(values, targetQuantile);
};

export const detectTimeDeviation = (
  sequence: readonly SimulationEvent[],
  options: TimeDeviationOptions = {},
): TimeDeviationEvent[] => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  const mergedOptions: TimeDeviationOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const cache = mergedOptions.statsCache ?? createThresholdCache();

  const baselineSource = Array.isArray(mergedOptions.baselineSequence)
    ? mergedOptions.baselineSequence
    : sequence;
  const baselineDeltas = extractDeltaSeries(baselineSource).filter((value) => isFiniteNumber(value));
  if (baselineDeltas.length > 0 && baselineSource !== sequence) {
    cache.seedGlobal(baselineDeltas);
  }
  const minSamples = Number.isInteger(mergedOptions.minSamples) && (mergedOptions.minSamples as number) > 0
    ? (mergedOptions.minSamples as number)
    : DEFAULT_OPTIONS.minSamples;

  let threshold = Number.NaN;
  if (baselineDeltas.length >= minSamples) {
    threshold = resolveThreshold(baselineDeltas, mergedOptions);
  } else {
    const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
    if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
      const fallback = Number(fallbackRaw);
      if (isFiniteNumber(fallback) && fallback >= 0) {
        threshold = fallback;
      }
    }
  }

  if (!isFiniteNumber(threshold) && baselineDeltas.length > 0) {
    threshold = resolveThreshold(baselineDeltas, { ...mergedOptions, minSamples: 1 });
  }

  if (!isFiniteNumber(threshold)) {
    const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
    if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
      const fallback = Number(fallbackRaw);
      if (isFiniteNumber(fallback) && fallback >= 0) {
        threshold = fallback;
      }
    }
  }

  if (!isFiniteNumber(threshold)) {
    threshold = 0;
  }

  const decorated: TimeDeviationEvent[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index] ?? null;
    const previous = index > 0 ? sequence[index - 1] ?? null : null;
    const observedDelta = index === 0 ? 0 : resolveDeltaSeconds(current, previous);
    const safeDelta = isFiniteNumber(observedDelta) ? observedDelta : 0;
    const uid = normalizeId((current as Record<string, unknown>)?.uid ?? (current as Record<string, unknown>)?.user_id);
    let opCategory: string | null = null;
    if (current && isObject((current as Record<string, unknown>).metadata)) {
      const meta = (current as Record<string, unknown>).metadata as Record<string, unknown>;
      const opCategoryRaw = (meta.op_category ?? meta.opCategory ?? meta.opCategoryCode) as unknown;
      opCategory = normalizeId(opCategoryRaw);
      const tierMeta = isObject(meta.time_deviation) ? meta.time_deviation : {};
      meta.time_deviation = { ...tierMeta } as Record<string, unknown>;
    }
    if (!opCategory) {
      const metadataRaw = (current as Record<string, unknown>)?.metadata;
      if (isObject(metadataRaw) && typeof metadataRaw.op_category === 'string') {
        opCategory = normalizeId(metadataRaw.op_category);
      }
      if (!opCategory) {
        opCategory = normalizeId((current as Record<string, unknown>)?.op_category);
      }
    }
    const resolution = cache.resolve(uid, opCategory, {
      method: mergedOptions.method ?? DEFAULT_OPTIONS.method,
      minSamples,
      quantile: mergedOptions.quantile ?? DEFAULT_OPTIONS.quantile,
      fallbackThresholdSeconds: mergedOptions.fallbackThresholdSeconds ?? null,
    });
    threshold = resolution.threshold;
    const score = Math.max(0, safeDelta - threshold);
    decorated.push({
      ...(current as Record<string, unknown>),
      metadata: (() => {
        const base = isObject((current as Record<string, unknown>).metadata)
          ? { ...((current as Record<string, unknown>).metadata as Record<string, unknown>) }
          : {};
        const tierMeta = isObject(base.time_deviation) ? { ...base.time_deviation } : {};
        tierMeta.threshold_seconds = threshold;
        tierMeta.threshold_tier = resolution.tier;
        tierMeta.sample_count = resolution.sampleCount;
        base.time_deviation = tierMeta;
        return base;
      })(),
      timeDeviationObservedDeltaSeconds: safeDelta,
      timeDeviationThresholdSeconds: threshold,
      timeDeviationScore: score,
      timeDeviationFlag: safeDelta > threshold,
      timeDeviationThresholdTier: resolution.tier,
      timeDeviationSampleCount: resolution.sampleCount,
    });

    if (uid || opCategory) {
      cache.record(uid, opCategory, safeDelta);
    } else {
      cache.record(null, null, safeDelta);
    }
  }

  return decorated;
};

const timeDeviationDetector = {
  detectTimeDeviation,
  extractDeltaSeries,
  resolveThreshold,
  createThresholdCache,
};

export default timeDeviationDetector;
