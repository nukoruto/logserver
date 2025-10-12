import type { SimulationEvent } from '../../services/simulationService';

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | string;
  quantile?: number;
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
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index] ?? null;
    const previous = index > 0 ? sequence[index - 1] ?? null : null;
    const observedDelta = index === 0 ? 0 : resolveDeltaSeconds(current, previous);
    const safeDelta = isFiniteNumber(observedDelta) ? observedDelta : 0;
    const score = Math.max(0, safeDelta - threshold);
    decorated.push({
      ...(current as Record<string, unknown>),
      timeDeviationObservedDeltaSeconds: safeDelta,
      timeDeviationThresholdSeconds: threshold,
      timeDeviationScore: score,
      timeDeviationFlag: safeDelta > threshold,
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
