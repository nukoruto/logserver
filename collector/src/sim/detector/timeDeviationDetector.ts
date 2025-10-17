import type { SimulationEvent } from '../../services/simulationService';

export interface SpotCalibrationMetadata {
  readonly method: 'spot';
  readonly sampleCount: number;
  readonly tailCount: number;
  readonly u: number;
  readonly xi: number;
  readonly beta: number;
  readonly pRef: number;
  readonly qStar: number;
  readonly tauT: number;
  readonly meanExcess: number;
}

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | string;
  quantile?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
  spotTailFraction?: number;
  spotTargetProbability?: number;
  spotMinTailCount?: number;
  spotXiEpsilon?: number;
  spotMetadata?: SpotCalibrationMetadata | null;
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationFlag?: boolean;
  timeDeviationSpotUSeconds?: number;
  timeDeviationSpotXi?: number;
  timeDeviationSpotBeta?: number;
  timeDeviationSpotPRef?: number;
  timeDeviationSpotQStar?: number;
  timeDeviationSpotTauTSeconds?: number;
  timeDeviationSpotTailCount?: number;
  timeDeviationSpotSampleCount?: number;
}

const DEFAULT_OPTIONS: Required<Pick<TimeDeviationOptions, 'method' | 'quantile' | 'minSamples' | 'fallbackThresholdSeconds'>> = {
  method: 'quantile',
  quantile: 0.99,
  minSamples: 5,
  fallbackThresholdSeconds: null,
};

const DEFAULT_SPOT_TAIL_FRACTION = 0.02;
const DEFAULT_SPOT_TARGET_PROBABILITY = 0.01;
const DEFAULT_SPOT_MIN_TAIL_COUNT = 5;
const DEFAULT_SPOT_XI_EPSILON = 1e-8;

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
    if (options) {
      options.spotMetadata = null;
    }
    return Number.NaN;
  }
  const quantileValue = Number(options.quantile);
  const targetQuantile = isFiniteNumber(quantileValue) ? quantileValue : DEFAULT_OPTIONS.quantile;
  const methodRaw = options.method;
  const method = typeof methodRaw === 'string' ? methodRaw.toLowerCase() : DEFAULT_OPTIONS.method;
  if (method === 'fixed') {
    options.spotMetadata = null;
    const fixed = Number(options.thresholdSeconds);
    return isFiniteNumber(fixed) ? fixed : Number.NaN;
  }
  if (method === 'spot') {
    const tailFractionRaw = Number(options.spotTailFraction);
    const tailFraction = isFiniteNumber(tailFractionRaw)
      ? Math.min(Math.max(tailFractionRaw, 0.001), 0.5)
      : DEFAULT_SPOT_TAIL_FRACTION;
    const minTailRaw = Number(options.spotMinTailCount);
    const minTailCount = Number.isFinite(minTailRaw) && minTailRaw > 0
      ? Math.max(Math.trunc(minTailRaw), 1)
      : DEFAULT_SPOT_MIN_TAIL_COUNT;
    const sorted = [...values].sort((a, b) => a - b);
    const total = sorted.length;
    const tailIndex = Math.max(Math.floor((1 - tailFraction) * total) - 1, 0);
    const u = sorted[tailIndex];
    const exceedances = values.filter((value) => value > u).map((value) => value - u);
    const tailCount = exceedances.length;
    let metadata: SpotCalibrationMetadata | null = null;
    if (tailCount >= minTailCount && tailCount > 0) {
      const meanExcess = exceedances.reduce((acc, value) => acc + value, 0) / tailCount;
      if (Number.isFinite(meanExcess) && meanExcess > 0) {
        const variance = exceedances.reduce((acc, value) => acc + (value - meanExcess) ** 2, 0) / tailCount;
        let xi = 0;
        let beta = meanExcess;
        if (Number.isFinite(variance) && variance > 0) {
          const ratio = (meanExcess * meanExcess) / variance;
          if (Number.isFinite(ratio) && ratio > 1) {
            xi = 0.5 * (ratio - 1);
            beta = 0.5 * meanExcess * (ratio + 1);
          }
        }
        if (!Number.isFinite(beta) || beta <= 0) {
          beta = Math.max(meanExcess, 1e-9);
        }
        if (!Number.isFinite(xi)) {
          xi = 0;
        }
        const pRef = tailCount / total;
        const targetProbabilityRaw = Number(options.spotTargetProbability);
        let qStar = isFiniteNumber(targetProbabilityRaw)
          ? targetProbabilityRaw
          : Math.max(1 - targetQuantile, DEFAULT_SPOT_TARGET_PROBABILITY);
        if (!Number.isFinite(qStar) || qStar <= 0) {
          qStar = DEFAULT_SPOT_TARGET_PROBABILITY;
        }
        qStar = Math.min(Math.max(qStar, 1e-9), 1);
        const xiEpsilonRaw = Number(options.spotXiEpsilon);
        const xiEpsilon = isFiniteNumber(xiEpsilonRaw) && xiEpsilonRaw > 0
          ? xiEpsilonRaw
          : DEFAULT_SPOT_XI_EPSILON;
        let threshold = u;
        if (qStar < pRef) {
          const ratio = Math.max(pRef / qStar, 1e-12);
          if (Math.abs(xi) < xiEpsilon) {
            threshold = u + beta * Math.log(ratio);
          } else {
            threshold = u + (beta / xi) * (Math.pow(ratio, xi) - 1);
          }
        }
        if (Number.isFinite(threshold)) {
          metadata = {
            method: 'spot',
            sampleCount: total,
            tailCount,
            u,
            xi,
            beta,
            pRef,
            qStar,
            tauT: threshold,
            meanExcess,
          };
        }
      }
    }
    options.spotMetadata = metadata;
    if (metadata) {
      return metadata.tauT;
    }
  }
  options.spotMetadata = null;
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
    mergedOptions.spotMetadata = null;
    const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
    if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
      const fallback = Number(fallbackRaw);
      if (isFiniteNumber(fallback) && fallback >= 0) {
        threshold = fallback;
      }
    }
  }

  if (!isFiniteNumber(threshold) && baselineDeltas.length > 0) {
    const fallbackOptions: TimeDeviationOptions = { ...mergedOptions, minSamples: 1 };
    threshold = resolveThreshold(baselineDeltas, fallbackOptions);
    mergedOptions.spotMetadata = fallbackOptions.spotMetadata ?? null;
  }

  if (!isFiniteNumber(threshold)) {
    const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
    if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
      const fallback = Number(fallbackRaw);
      if (isFiniteNumber(fallback) && fallback >= 0) {
        threshold = fallback;
        mergedOptions.spotMetadata = null;
      }
    }
  }

  if (!isFiniteNumber(threshold)) {
    mergedOptions.spotMetadata = null;
    threshold = 0;
  }

  const spotMetadata = mergedOptions.spotMetadata && mergedOptions.spotMetadata.method === 'spot'
    ? mergedOptions.spotMetadata
    : null;

  const decorated: TimeDeviationEvent[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index] ?? null;
    const previous = index > 0 ? sequence[index - 1] ?? null : null;
    const observedDelta = index === 0 ? 0 : resolveDeltaSeconds(current, previous);
    const safeDelta = isFiniteNumber(observedDelta) ? observedDelta : 0;
    const score = Math.max(0, safeDelta - threshold);
    const annotated: TimeDeviationEvent = {
      ...(current as Record<string, unknown>),
      timeDeviationObservedDeltaSeconds: safeDelta,
      timeDeviationThresholdSeconds: threshold,
      timeDeviationScore: score,
      timeDeviationFlag: safeDelta > threshold,
    };
    if (spotMetadata) {
      annotated.timeDeviationSpotUSeconds = spotMetadata.u;
      annotated.timeDeviationSpotXi = spotMetadata.xi;
      annotated.timeDeviationSpotBeta = spotMetadata.beta;
      annotated.timeDeviationSpotPRef = spotMetadata.pRef;
      annotated.timeDeviationSpotQStar = spotMetadata.qStar;
      annotated.timeDeviationSpotTauTSeconds = spotMetadata.tauT;
      annotated.timeDeviationSpotTailCount = spotMetadata.tailCount;
      annotated.timeDeviationSpotSampleCount = spotMetadata.sampleCount;
    }
    decorated.push(annotated);
  }

  return decorated;
};

const timeDeviationDetector = {
  detectTimeDeviation,
  extractDeltaSeries,
  resolveThreshold,
};

export default timeDeviationDetector;
