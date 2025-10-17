import type { SimulationEvent } from '../../services/simulationService';

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | 'otsu' | 'knee' | string;
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

export interface TimeDeviationHistogramDiagnostics {
  binEdgesSeconds: number[];
  binEdgesLogSeconds: number[];
  counts: number[];
  total: number;
  method: 'log';
}

export interface TimeDeviationDiagnostics {
  method: string;
  baselineCount: number;
  baselineMeanSeconds: number | null;
  baselineStdSeconds: number | null;
  baselineMinSeconds: number | null;
  baselineMaxSeconds: number | null;
  thresholdSeconds: number;
  fallbackApplied: boolean;
  quantile?: number | null;
  otsu?: {
    thresholdSeconds: number | null;
    logThreshold: number | null;
    betweenClassVariance: number | null;
    histogram: TimeDeviationHistogramDiagnostics | null;
  } | null;
  knee?: {
    thresholdSeconds: number | null;
    logThreshold: number | null;
    sampleIndex: number | null;
    normalizedIndex: number | null;
    distance: number | null;
  } | null;
}

export interface TimeDeviationDetectionResult {
  events: TimeDeviationEvent[];
  thresholdSeconds: number;
  diagnostics: TimeDeviationDiagnostics;
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

const toFiniteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

const computeMean = (values: readonly number[]): number => {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
};

const computeStd = (values: readonly number[]): number => {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }
  const mean = computeMean(values);
  if (!Number.isFinite(mean)) {
    return Number.NaN;
  }
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  return variance > 0 ? Math.sqrt(variance) : 0;
};

interface HistogramResult {
  counts: number[];
  binEdgesLog: number[];
  binEdges: number[];
  binMidsLog: number[];
}

const buildLogHistogram = (values: readonly number[]): HistogramResult | null => {
  const positive = values.filter((value) => isFiniteNumber(value) && value > 0);
  if (positive.length === 0) {
    return null;
  }
  const logs = positive.map((value) => Math.log(value));
  const minLog = Math.min(...logs);
  const maxLog = Math.max(...logs);
  if (!Number.isFinite(minLog) || !Number.isFinite(maxLog)) {
    return null;
  }
  const range = maxLog - minLog;
  const binCount = Math.max(8, Math.min(128, Math.round(Math.sqrt(positive.length))));
  if (range <= 1e-12) {
    const binEdgesLog = [minLog, maxLog + 1e-12];
    const binEdges = binEdgesLog.map((value) => Math.exp(value));
    return {
      counts: [positive.length],
      binEdgesLog,
      binEdges,
      binMidsLog: [(binEdgesLog[0] + binEdgesLog[1]) / 2],
    };
  }
  const binWidth = range / binCount;
  const binEdgesLog = new Array(binCount + 1).fill(0).map((_, index) => minLog + index * binWidth);
  const counts = new Array(binCount).fill(0);
  for (const logValue of logs) {
    let binIndex = Math.floor((logValue - minLog) / binWidth);
    if (binIndex < 0) {
      binIndex = 0;
    }
    if (binIndex >= binCount) {
      binIndex = binCount - 1;
    }
    counts[binIndex] += 1;
  }
  const binEdges = binEdgesLog.map((value) => Math.exp(value));
  const binMidsLog = counts.map((_, index) => (binEdgesLog[index] + binEdgesLog[index + 1]) / 2);
  return {
    counts,
    binEdgesLog,
    binEdges,
    binMidsLog,
  };
};

const computeOtsuLogThreshold = (values: readonly number[]): {
  threshold: number;
  logThreshold: number;
  betweenClassVariance: number;
  histogram: HistogramResult | null;
} | null => {
  const histogram = buildLogHistogram(values);
  if (!histogram) {
    return null;
  }
  const { counts, binMidsLog } = histogram;
  const total = counts.reduce((acc, value) => acc + value, 0);
  if (total === 0) {
    return null;
  }
  const probabilities = counts.map((count) => count / total);
  const meanLog = probabilities.reduce((acc, probability, index) => acc + probability * binMidsLog[index], 0);
  let bestVariance = -Infinity;
  let bestThresholdLog = binMidsLog[binMidsLog.length - 1];
  let cumulativeProbability = 0;
  let cumulativeMeanLog = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const probability = probabilities[index];
    cumulativeProbability += probability;
    cumulativeMeanLog += probability * binMidsLog[index];
    if (cumulativeProbability <= 0 || cumulativeProbability >= 1) {
      continue;
    }
    const meanBackground = cumulativeMeanLog / cumulativeProbability;
    const meanForeground = (meanLog - cumulativeMeanLog) / (1 - cumulativeProbability);
    const variance = cumulativeProbability * (1 - cumulativeProbability) * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThresholdLog = binMidsLog[index];
    }
  }
  const threshold = Math.exp(bestThresholdLog);
  return {
    threshold,
    logThreshold: bestThresholdLog,
    betweenClassVariance: Number.isFinite(bestVariance) ? bestVariance : Number.NaN,
    histogram,
  };
};

const computeKneeThreshold = (values: readonly number[]): {
  threshold: number;
  logThreshold: number;
  sampleIndex: number;
  normalizedIndex: number;
  distance: number;
} | null => {
  const positive = values.filter((value) => isFiniteNumber(value) && value > 0).map((value) => Math.log(value));
  if (positive.length === 0) {
    return null;
  }
  const sorted = [...positive].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return {
      threshold: Math.exp(sorted[0]),
      logThreshold: sorted[0],
      sampleIndex: 0,
      normalizedIndex: 0,
      distance: 0,
    };
  }
  const minLog = sorted[0];
  const maxLog = sorted[sorted.length - 1];
  const denom = Math.sqrt(2);
  if (maxLog - minLog <= 1e-12) {
    return {
      threshold: Math.exp(sorted[sorted.length - 1]),
      logThreshold: sorted[sorted.length - 1],
      sampleIndex: sorted.length - 1,
      normalizedIndex: 1,
      distance: 0,
    };
  }
  let bestDistance = -Infinity;
  let bestIndex = sorted.length - 1;
  for (let index = 0; index < sorted.length; index += 1) {
    const normalizedIndex = index / (sorted.length - 1);
    const normalizedValue = (sorted[index] - minLog) / (maxLog - minLog);
    const distance = Math.abs(normalizedValue - normalizedIndex) / denom;
    if (distance > bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  const logThreshold = sorted[bestIndex];
  return {
    threshold: Math.exp(logThreshold),
    logThreshold,
    sampleIndex: bestIndex,
    normalizedIndex: sorted.length > 1 ? bestIndex / (sorted.length - 1) : 0,
    distance: bestDistance,
  };
};

interface ThresholdResolution {
  method: string;
  threshold: number;
  diagnostics: Partial<TimeDeviationDiagnostics>;
}

const resolveThresholdDetailed = (
  values: readonly number[],
  options: TimeDeviationOptions,
): ThresholdResolution => {
  if (!Array.isArray(values) || values.length === 0) {
    return { method: DEFAULT_OPTIONS.method, threshold: Number.NaN, diagnostics: {} };
  }
  const methodRaw = options.method;
  const method = typeof methodRaw === 'string' ? methodRaw.toLowerCase() : DEFAULT_OPTIONS.method;
  if (method === 'fixed') {
    const fixed = Number(options.thresholdSeconds);
    return {
      method,
      threshold: isFiniteNumber(fixed) ? fixed : Number.NaN,
      diagnostics: {},
    };
  }
  if (method === 'spot') {
    return {
      method,
      threshold: Number.NaN,
      diagnostics: {},
    };
  }
  if (method === 'otsu') {
    const otsu = computeOtsuLogThreshold(values);
    if (!otsu) {
      return { method, threshold: Number.NaN, diagnostics: { otsu: null } };
    }
    return {
      method,
      threshold: otsu.threshold,
      diagnostics: {
        otsu: {
          thresholdSeconds: otsu.threshold,
          logThreshold: otsu.logThreshold,
          betweenClassVariance: otsu.betweenClassVariance,
          histogram: otsu.histogram
            ? {
                binEdgesSeconds: otsu.histogram.binEdges,
                binEdgesLogSeconds: otsu.histogram.binEdgesLog,
                counts: otsu.histogram.counts,
                total: otsu.histogram.counts.reduce((acc, value) => acc + value, 0),
                method: 'log',
              }
            : null,
        },
      },
    };
  }
  if (method === 'knee') {
    const otsu = computeOtsuLogThreshold(values);
    const knee = computeKneeThreshold(values);
    const otsuThreshold = otsu?.threshold;
    const kneeThreshold = knee?.threshold;
    const resolvedThresholdCandidates = [otsuThreshold, kneeThreshold].filter((value) => isFiniteNumber(value));
    const threshold = resolvedThresholdCandidates.length > 0 ? Math.max(...resolvedThresholdCandidates) : Number.NaN;
    return {
      method,
      threshold,
      diagnostics: {
        otsu: otsu
          ? {
              thresholdSeconds: otsu.threshold,
              logThreshold: otsu.logThreshold,
              betweenClassVariance: otsu.betweenClassVariance,
              histogram: otsu.histogram
                ? {
                    binEdgesSeconds: otsu.histogram.binEdges,
                    binEdgesLogSeconds: otsu.histogram.binEdgesLog,
                    counts: otsu.histogram.counts,
                    total: otsu.histogram.counts.reduce((acc, value) => acc + value, 0),
                    method: 'log',
                  }
                : null,
            }
          : null,
        knee: knee
          ? {
              thresholdSeconds: knee.threshold,
              logThreshold: knee.logThreshold,
              sampleIndex: knee.sampleIndex,
              normalizedIndex: knee.normalizedIndex,
              distance: knee.distance,
            }
          : null,
      },
    };
  }
  const quantileValue = Number(options.quantile);
  const targetQuantile = isFiniteNumber(quantileValue) ? quantileValue : DEFAULT_OPTIONS.quantile;
  return {
    method,
    threshold: computeQuantile(values, targetQuantile),
    diagnostics: {
      quantile: targetQuantile,
    },
  };
};

export const resolveThreshold = (
  values: readonly number[],
  options: TimeDeviationOptions,
): number => {
  return resolveThresholdDetailed(values, options).threshold;
};

export const detectTimeDeviation = (
  sequence: readonly SimulationEvent[],
  options: TimeDeviationOptions = {},
): TimeDeviationDetectionResult => {
  if (!Array.isArray(sequence)) {
    return {
      events: [],
      thresholdSeconds: 0,
      diagnostics: {
        method: DEFAULT_OPTIONS.method,
        baselineCount: 0,
        baselineMeanSeconds: null,
        baselineStdSeconds: null,
        baselineMinSeconds: null,
        baselineMaxSeconds: null,
        thresholdSeconds: 0,
        fallbackApplied: false,
        quantile: null,
        otsu: null,
        knee: null,
      },
    };
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

  const diagnosticsBase: TimeDeviationDiagnostics = {
    method: typeof mergedOptions.method === 'string' ? mergedOptions.method : DEFAULT_OPTIONS.method,
    baselineCount: baselineDeltas.length,
    baselineMeanSeconds:
      baselineDeltas.length > 0 ? toFiniteOrNull(computeMean(baselineDeltas)) : null,
    baselineStdSeconds: baselineDeltas.length > 0 ? toFiniteOrNull(computeStd(baselineDeltas)) : null,
    baselineMinSeconds: baselineDeltas.length > 0 ? toFiniteOrNull(Math.min(...baselineDeltas)) : null,
    baselineMaxSeconds: baselineDeltas.length > 0 ? toFiniteOrNull(Math.max(...baselineDeltas)) : null,
    thresholdSeconds: 0,
    fallbackApplied: false,
    quantile: null,
    otsu: null,
    knee: null,
  };

  let threshold = Number.NaN;
  let thresholdDiagnostics: Partial<TimeDeviationDiagnostics> = {};
  let fallbackApplied = false;
  if (baselineDeltas.length >= minSamples) {
    const resolution = resolveThresholdDetailed(baselineDeltas, mergedOptions);
    threshold = resolution.threshold;
    thresholdDiagnostics = resolution.diagnostics;
    diagnosticsBase.method = resolution.method;
  } else {
    const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
    if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
      const fallback = Number(fallbackRaw);
      if (isFiniteNumber(fallback) && fallback >= 0) {
        threshold = fallback;
        fallbackApplied = true;
      }
    }
  }

  if (!isFiniteNumber(threshold) && baselineDeltas.length > 0) {
    const resolution = resolveThresholdDetailed(baselineDeltas, { ...mergedOptions, minSamples: 1 });
    threshold = resolution.threshold;
    thresholdDiagnostics = resolution.diagnostics;
    diagnosticsBase.method = resolution.method;
  }

  if (!isFiniteNumber(threshold)) {
    const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
    if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
      const fallback = Number(fallbackRaw);
      if (isFiniteNumber(fallback) && fallback >= 0) {
        threshold = fallback;
        fallbackApplied = true;
      }
    }
  }

  if (!isFiniteNumber(threshold)) {
    threshold = 0;
  }

  const diagnostics: TimeDeviationDiagnostics = {
    ...diagnosticsBase,
    thresholdSeconds: threshold,
    fallbackApplied,
    quantile: typeof thresholdDiagnostics.quantile === 'number' ? thresholdDiagnostics.quantile : diagnosticsBase.quantile,
    otsu: thresholdDiagnostics.otsu !== undefined ? (thresholdDiagnostics.otsu ?? null) : diagnosticsBase.otsu,
    knee: thresholdDiagnostics.knee !== undefined ? (thresholdDiagnostics.knee ?? null) : diagnosticsBase.knee,
  };

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

  return {
    events: decorated,
    thresholdSeconds: threshold,
    diagnostics,
  };
};

const timeDeviationDetector = {
  detectTimeDeviation,
  extractDeltaSeries,
  resolveThreshold,
};

export default timeDeviationDetector;
