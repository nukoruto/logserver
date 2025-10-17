import type { SimulationEvent } from '../../services/simulationService';

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | string;
  quantile?: number;
  quantileUpper?: number;
  quantileLower?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationFlag?: boolean;
  tau_hi?: number;
  tau_lo?: number;
  s_Q?: number;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    TimeDeviationOptions,
    'method' | 'quantile' | 'quantileUpper' | 'quantileLower' | 'minSamples' | 'fallbackThresholdSeconds'
  >
> = {
  method: 'quantile',
  quantile: 0.99,
  quantileUpper: 0.99,
  quantileLower: 0.01,
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

export interface ThresholdPair {
  readonly tauHi: number;
  readonly tauLo: number;
}

const clampQuantile = (value: number, fallback: number): number => {
  const epsilon = 1e-9;
  if (!isFiniteNumber(value)) {
    return Math.min(Math.max(fallback, epsilon), 1 - epsilon);
  }
  return Math.min(Math.max(value, epsilon), 1 - epsilon);
};

const computeThresholdPair = (
  values: readonly number[],
  quantileUpper: number,
  quantileLower: number,
): ThresholdPair | null => {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const tauHi = computeQuantile(values, quantileUpper);
  const tauLo = computeQuantile(values, quantileLower);
  if (!isFiniteNumber(tauHi) || !isFiniteNumber(tauLo)) {
    return null;
  }
  if (tauHi < tauLo) {
    return { tauHi: tauLo, tauLo: tauHi };
  }
  return { tauHi, tauLo };
};

export const resolveThreshold = (
  values: readonly number[],
  options: TimeDeviationOptions,
): ThresholdPair | null => {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const methodRaw = options.method;
  const method = typeof methodRaw === 'string' ? methodRaw.toLowerCase() : DEFAULT_OPTIONS.method;
  if (method === 'fixed') {
    const fixed = Number(options.thresholdSeconds);
    if (isFiniteNumber(fixed)) {
      return { tauHi: fixed, tauLo: 0 };
    }
    return null;
  }
  if (method === 'spot') {
    // TODO: Implement SPOT (Peaks Over Threshold) method.
    // Fallback to quantile-based threshold for initial implementation.
  }
  const quantileUpperValue = options.quantileUpper ?? options.quantile;
  let quantileUpper = clampQuantile(
    isFiniteNumber(quantileUpperValue) ? (quantileUpperValue as number) : DEFAULT_OPTIONS.quantileUpper,
    DEFAULT_OPTIONS.quantileUpper,
  );
  let quantileLower = clampQuantile(
    isFiniteNumber(options.quantileLower)
      ? (options.quantileLower as number)
      : Math.min(DEFAULT_OPTIONS.quantileLower, 1 - quantileUpper),
    DEFAULT_OPTIONS.quantileLower,
  );
  if (quantileLower >= quantileUpper) {
    quantileLower = Math.max(quantileUpper - 1e-6, 1e-9);
  }
  return computeThresholdPair(values, quantileUpper, quantileLower);
};

const resolveUid = (event: SimulationEvent | null | undefined): string | null => {
  if (!event) {
    return null;
  }
  const candidates = [
    (event as Record<string, unknown>).uid,
    (event as Record<string, unknown>).user_id,
    (event as Record<string, unknown>).userId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
};

const resolveOpCategory = (event: SimulationEvent | null | undefined): string | null => {
  if (!event) {
    return null;
  }
  const metadata = (event as SimulationEvent).metadata;
  const candidates = [
    (event as Record<string, unknown>).op_category,
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).op_category : null,
    (event as Record<string, unknown>).category,
    (event as Record<string, unknown>).category_code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
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
  const quantileUpperValue = mergedOptions.quantileUpper ?? mergedOptions.quantile;
  let quantileUpper = clampQuantile(
    isFiniteNumber(quantileUpperValue) ? (quantileUpperValue as number) : DEFAULT_OPTIONS.quantileUpper,
    DEFAULT_OPTIONS.quantileUpper,
  );
  let quantileLower = clampQuantile(
    isFiniteNumber(mergedOptions.quantileLower)
      ? (mergedOptions.quantileLower as number)
      : Math.min(DEFAULT_OPTIONS.quantileLower, 1 - quantileUpper),
    DEFAULT_OPTIONS.quantileLower,
  );
  if (quantileLower >= quantileUpper) {
    quantileLower = Math.max(quantileUpper - 1e-6, 1e-9);
  }
  const globalDeltas: number[] = [];
  const userDeltas = new Map<string, number[]>();
  const groupDeltas = new Map<string, number[]>();
  for (let index = 1; index < baselineSource.length; index += 1) {
    const current = baselineSource[index] ?? null;
    const previous = baselineSource[index - 1] ?? null;
    const delta = resolveDeltaSeconds(current, previous);
    if (!isFiniteNumber(delta)) {
      continue;
    }
    const uid = resolveUid(current);
    const previousUid = resolveUid(previous);
    const sameUid = uid !== null && previousUid !== null && uid === previousUid;
    if (!sameUid && uid !== null && previousUid !== null) {
      continue;
    }
    globalDeltas.push(delta);
    if (!sameUid || !uid) {
      continue;
    }
    const userList = userDeltas.get(uid);
    if (userList === undefined) {
      userDeltas.set(uid, [delta]);
    } else {
      userList.push(delta);
    }
    const opCategory = resolveOpCategory(current);
    if (!opCategory) {
      continue;
    }
    const groupKey = `${uid}||${opCategory}`;
    const groupList = groupDeltas.get(groupKey);
    if (groupList === undefined) {
      groupDeltas.set(groupKey, [delta]);
    } else {
      groupList.push(delta);
    }
  }
  const minSamples = Number.isInteger(mergedOptions.minSamples) && (mergedOptions.minSamples as number) > 0
    ? (mergedOptions.minSamples as number)
    : DEFAULT_OPTIONS.minSamples;
  const groupThresholds = new Map<string, ThresholdPair>();
  for (const [key, values] of groupDeltas.entries()) {
    if (values.length < minSamples) {
      continue;
    }
    const pair = computeThresholdPair(values, quantileUpper, quantileLower);
    if (pair) {
      groupThresholds.set(key, pair);
    }
  }
  const userThresholds = new Map<string, ThresholdPair>();
  for (const [key, values] of userDeltas.entries()) {
    if (values.length < minSamples) {
      continue;
    }
    const pair = computeThresholdPair(values, quantileUpper, quantileLower);
    if (pair) {
      userThresholds.set(key, pair);
    }
  }
  let globalPair: ThresholdPair | null = null;
  if (globalDeltas.length >= minSamples) {
    globalPair = computeThresholdPair(globalDeltas, quantileUpper, quantileLower);
  }
  let fallbackPair: ThresholdPair | null = null;
  const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
  if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
    const fallback = Number(fallbackRaw);
    if (isFiniteNumber(fallback) && fallback >= 0) {
      fallbackPair = { tauHi: fallback, tauLo: 0 };
    }
  }
  if (!globalPair && !fallbackPair && globalDeltas.length > 0) {
    globalPair = computeThresholdPair(globalDeltas, quantileUpper, quantileLower);
  }
  if (!globalPair) {
    globalPair = fallbackPair ?? { tauHi: 0, tauLo: 0 };
  }
  const decorated: TimeDeviationEvent[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index] ?? null;
    const previous = index > 0 ? sequence[index - 1] ?? null : null;
    const observedDelta = index === 0 ? null : resolveDeltaSeconds(current, previous);
    const hasDelta = isFiniteNumber(observedDelta);
    const safeDelta = hasDelta ? (observedDelta as number) : 0;
    const uid = resolveUid(current);
    const opCategory = resolveOpCategory(current);
    let thresholds: ThresholdPair | null = null;
    if (uid && opCategory) {
      thresholds = groupThresholds.get(`${uid}||${opCategory}`) ?? null;
    }
    if (!thresholds && uid) {
      thresholds = userThresholds.get(uid) ?? null;
    }
    if (!thresholds) {
      thresholds = globalPair;
    }
    const tauHi = thresholds?.tauHi ?? 0;
    const tauLo = thresholds?.tauLo ?? 0;
    const safeTauHi = Math.max(tauHi, 1e-9);
    const safeTauLo = Math.max(tauLo, 1e-9);
    const safeValue = Math.max(Math.abs(safeDelta), 1e-9);
    const exceedUpper = hasDelta && safeDelta > tauHi;
    const exceedLower = hasDelta && safeDelta < tauLo;
    let score = 0;
    if (exceedUpper) {
      score = safeDelta - tauHi;
    } else if (exceedLower) {
      score = tauLo - safeDelta;
    }
    let sQ = 1;
    if (exceedUpper) {
      sQ = safeDelta / safeTauHi;
    } else if (exceedLower) {
      sQ = safeTauLo / safeValue;
    }
    decorated.push({
      ...(current as Record<string, unknown>),
      timeDeviationObservedDeltaSeconds: safeDelta,
      timeDeviationThresholdSeconds: tauHi,
      timeDeviationScore: score,
      timeDeviationFlag: hasDelta ? exceedUpper || exceedLower : false,
      tau_hi: tauHi,
      tau_lo: tauLo,
      s_Q: sQ,
    });
  }

  return decorated;
};

const timeDeviationDetector = {
  detectTimeDeviation,
  extractDeltaSeries,
  resolveThreshold,
};

export default timeDeviationDetector;
