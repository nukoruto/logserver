import type { SimulationEvent } from '../../services/simulationService';

export interface TimeDeviationVotingOptions extends Record<string, unknown> {
  enabled?: boolean;
  k?: number;
  n?: number;
}

export interface TimeDeviationHysteresisOptions extends Record<string, unknown> {
  enabled?: boolean;
  holdCount?: number;
}

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | string;
  quantile?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
  voting?: TimeDeviationVotingOptions;
  hysteresis?: TimeDeviationHysteresisOptions;
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationRawFlag?: boolean;
  timeDeviationVotingFlag?: boolean;
  timeDeviationHoldRemaining?: number;
  timeDeviationFlag?: boolean;
}

const DEFAULT_OPTIONS: Required<Pick<TimeDeviationOptions, 'method' | 'quantile' | 'minSamples' | 'fallbackThresholdSeconds'>> = {
  method: 'quantile',
  quantile: 0.99,
  minSamples: 5,
  fallbackThresholdSeconds: null,
};

type NormalizedVotingOptions = {
  enabled: boolean;
  k: number;
  n: number;
};

type NormalizedHysteresisOptions = {
  enabled: boolean;
  holdCount: number;
};

const DEFAULT_VOTING_OPTIONS: NormalizedVotingOptions = {
  enabled: true,
  k: 1,
  n: 1,
};

const DEFAULT_HYSTERESIS_OPTIONS: NormalizedHysteresisOptions = {
  enabled: true,
  holdCount: 0,
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

const normalizeVotingOptions = (input?: TimeDeviationVotingOptions | null): NormalizedVotingOptions => {
  const enabled = input?.enabled === false ? false : true;
  const kCandidate = Number((input as Record<string, unknown> | undefined)?.k);
  const nCandidate = Number((input as Record<string, unknown> | undefined)?.n);
  const normalizedN = Number.isInteger(nCandidate) && (nCandidate as number) > 0
    ? (nCandidate as number)
    : DEFAULT_VOTING_OPTIONS.n;
  const normalizedK = Number.isInteger(kCandidate) && (kCandidate as number) > 0
    ? Math.min(kCandidate as number, normalizedN)
    : Math.min(DEFAULT_VOTING_OPTIONS.k, normalizedN);
  return {
    enabled,
    k: normalizedK,
    n: normalizedN,
  };
};

const normalizeHysteresisOptions = (input?: TimeDeviationHysteresisOptions | null): NormalizedHysteresisOptions => {
  const enabled = input?.enabled === false ? false : true;
  const holdCandidate = Number((input as Record<string, unknown> | undefined)?.holdCount);
  const holdCount = Number.isInteger(holdCandidate) && (holdCandidate as number) >= 0
    ? (holdCandidate as number)
    : DEFAULT_HYSTERESIS_OPTIONS.holdCount;
  return {
    enabled,
    holdCount,
  };
};

const applyVoting = (rawFlags: readonly boolean[], options: NormalizedVotingOptions): boolean[] => {
  if (!options.enabled) {
    return rawFlags.slice();
  }
  const windowSize = Math.max(1, options.n);
  const required = Math.max(1, Math.min(options.k, windowSize));
  const result: boolean[] = new Array(rawFlags.length).fill(false);
  const window: boolean[] = [];
  let activeCount = 0;
  for (let index = 0; index < rawFlags.length; index += 1) {
    const flag = rawFlags[index] === true;
    window.push(flag);
    if (flag) {
      activeCount += 1;
    }
    if (window.length > windowSize) {
      const removed = window.shift();
      if (removed) {
        activeCount -= 1;
      }
    }
    result[index] = activeCount >= required;
  }
  return result;
};

const applyHysteresis = (
  votingFlags: readonly boolean[],
  options: NormalizedHysteresisOptions,
): { finalFlags: boolean[]; holdRemaining: number[] } => {
  if (!options.enabled || options.holdCount <= 0) {
    return {
      finalFlags: votingFlags.slice(),
      holdRemaining: new Array(votingFlags.length).fill(0),
    };
  }
  const finalFlags: boolean[] = new Array(votingFlags.length).fill(false);
  const holdRemaining: number[] = new Array(votingFlags.length).fill(0);
  let remaining = 0;
  const holdCount = Math.max(0, options.holdCount);
  for (let index = 0; index < votingFlags.length; index += 1) {
    if (votingFlags[index]) {
      remaining = holdCount;
      finalFlags[index] = true;
      holdRemaining[index] = remaining;
    } else if (remaining > 0) {
      remaining -= 1;
      finalFlags[index] = true;
      holdRemaining[index] = remaining;
    } else {
      remaining = 0;
      finalFlags[index] = false;
      holdRemaining[index] = 0;
    }
  }
  return { finalFlags, holdRemaining };
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

  const baselineSource = Array.isArray(mergedOptions.baselineSequence)
    ? mergedOptions.baselineSequence
    : sequence;
  const baselineDeltas = extractDeltaSeries(baselineSource).filter((value) => isFiniteNumber(value));
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
  const rawFlags: boolean[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index] ?? null;
    const previous = index > 0 ? sequence[index - 1] ?? null : null;
    const observedDelta = index === 0 ? 0 : resolveDeltaSeconds(current, previous);
    const safeDelta = isFiniteNumber(observedDelta) ? observedDelta : 0;
    const score = Math.max(0, safeDelta - threshold);
    const rawFlag = safeDelta > threshold;
    rawFlags.push(rawFlag);
    decorated.push({
      ...(current as Record<string, unknown>),
      timeDeviationObservedDeltaSeconds: safeDelta,
      timeDeviationThresholdSeconds: threshold,
      timeDeviationScore: score,
      timeDeviationRawFlag: rawFlag,
      timeDeviationFlag: rawFlag,
    });
  }

  const votingOptions = normalizeVotingOptions(options.voting || null);
  const hysteresisOptions = normalizeHysteresisOptions(options.hysteresis || null);

  const votingFlags = applyVoting(rawFlags, votingOptions);
  const { finalFlags, holdRemaining } = applyHysteresis(votingFlags, hysteresisOptions);

  for (let index = 0; index < decorated.length; index += 1) {
    decorated[index].timeDeviationVotingFlag = votingFlags[index];
    decorated[index].timeDeviationHoldRemaining = holdRemaining[index];
    decorated[index].timeDeviationFlag = finalFlags[index];
  }

  return decorated;
};

const timeDeviationDetector = {
  detectTimeDeviation,
  extractDeltaSeries,
  resolveThreshold,
};

export default timeDeviationDetector;
