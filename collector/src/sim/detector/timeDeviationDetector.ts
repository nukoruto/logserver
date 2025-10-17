import type { SimulationEvent } from '../../services/simulationService';

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | 'otsu' | 'knee' | string;
  quantile?: number;
  quantileUpper?: number;
  quantileLower?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  fallbackLowerThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  lowerThresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationThresholdLowerSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationFlag?: boolean;
  tau_hi?: number;
  tau_lo?: number;
  s_Q?: number;
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
  thresholdLowerSeconds: number;
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
  groupThresholds?: Record<string, {
    tauHiSeconds: number;
    tauLoSeconds: number;
    sampleCount: number;
    fallbackToGlobal: boolean;
  }>;
}

export interface TimeDeviationDetectionResult {
  events: TimeDeviationEvent[];
  thresholdSeconds: number;
  thresholdLowerSeconds: number;
  diagnostics: TimeDeviationDiagnostics;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    TimeDeviationOptions,
    | 'method'
    | 'quantile'
    | 'quantileUpper'
    | 'quantileLower'
    | 'minSamples'
    | 'fallbackThresholdSeconds'
    | 'fallbackLowerThresholdSeconds'
  >
> = {
  method: 'quantile',
  quantile: 0.99,
  quantileUpper: 0.99,
  quantileLower: 0.01,
  minSamples: 5,
  fallbackThresholdSeconds: null,
  fallbackLowerThresholdSeconds: null,
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

const readString = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
};

const extractUid = (event: SimulationEvent | null | undefined): string | null => {
  if (!event) {
    return null;
  }
  const direct = readString((event as Record<string, unknown>).uid)
    ?? readString((event as Record<string, unknown>).user_id)
    ?? readString((event as Record<string, unknown>).session_id);
  if (direct) {
    return direct;
  }
  const metadataRaw = (event as Record<string, unknown>).metadata;
  if (metadataRaw && typeof metadataRaw === 'object') {
    const metadata = metadataRaw as Record<string, unknown>;
    const metaUid = readString(metadata.uid);
    if (metaUid) {
      return metaUid;
    }
  }
  return null;
};

const extractCategory = (event: SimulationEvent | null | undefined): string | null => {
  if (!event) {
    return null;
  }
  const fromEvent = readString((event as Record<string, unknown>).op_category)
    ?? readString((event as Record<string, unknown>).category)
    ?? readString((event as Record<string, unknown>).category_code);
  if (fromEvent) {
    return fromEvent;
  }
  const metadataRaw = (event as Record<string, unknown>).metadata;
  if (metadataRaw && typeof metadataRaw === 'object') {
    const metadata = metadataRaw as Record<string, unknown>;
    const metaCategory = readString(metadata.op_category)
      ?? readString(metadata.category)
      ?? readString(metadata.category_code);
    if (metaCategory) {
      return metaCategory;
    }
  }
  return null;
};

const buildGroupKey = (uid: string | null, category: string | null): string => {
  const userPart = uid ?? '__global__';
  const categoryPart = category ?? '__global__';
  return `${userPart}||${categoryPart}`;
};

interface GroupThresholdSummary {
  tauHiSeconds: number;
  tauLoSeconds: number;
  sampleCount: number;
  fallbackToGlobal: boolean;
}

const normalizeTauPair = (tauHi: number, tauLo: number, fallbackHi: number, fallbackLo: number): {
  tauHi: number;
  tauLo: number;
} => {
  const hiCandidate = Number.isFinite(tauHi) ? tauHi : fallbackHi;
  const loCandidate = Number.isFinite(tauLo) ? tauLo : fallbackLo;
  const nonNegativeHi = Math.max(hiCandidate, 0);
  const boundedLo = Math.max(Math.min(loCandidate, nonNegativeHi), 0);
  return { tauHi: nonNegativeHi, tauLo: boundedLo };
};

const parseOptionalFiniteNumber = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numeric = Number(value);
  return isFiniteNumber(numeric) ? numeric : null;
};

const resolveQuantileValue = (value: unknown, fallback: number): number => {
  const numeric = parseOptionalFiniteNumber(value);
  if (numeric === null) {
    return fallback;
  }
  if (numeric < 0) {
    return 0;
  }
  if (numeric > 1) {
    return 1;
  }
  return numeric;
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
  lowerThreshold: number;
  diagnostics: Partial<TimeDeviationDiagnostics>;
}

const resolveThresholdDetailed = (
  values: readonly number[],
  options: TimeDeviationOptions,
): ThresholdResolution => {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      method: DEFAULT_OPTIONS.method,
      threshold: Number.NaN,
      lowerThreshold: Number.NaN,
      diagnostics: {},
    };
  }
  const methodRaw = options.method;
  const method = typeof methodRaw === 'string' ? methodRaw.toLowerCase() : DEFAULT_OPTIONS.method;
  const quantileUpperCandidate = resolveQuantileValue(
    options.quantileUpper ?? options.quantile,
    DEFAULT_OPTIONS.quantileUpper,
  );
  const quantileLowerCandidate = resolveQuantileValue(
    options.quantileLower,
    DEFAULT_OPTIONS.quantileLower,
  );
  const quantileUpper = Math.max(quantileUpperCandidate, quantileLowerCandidate);
  const quantileLower = Math.min(quantileUpperCandidate, quantileLowerCandidate);
  const lowerQuantileThreshold = computeQuantile(values, quantileLower);
  if (method === 'fixed') {
    const fixed = parseOptionalFiniteNumber(options.thresholdSeconds);
    const lowerFixed = parseOptionalFiniteNumber(
      options.lowerThresholdSeconds ?? options.fallbackLowerThresholdSeconds,
    );
    return {
      method,
      threshold: fixed ?? Number.NaN,
      lowerThreshold: lowerFixed ?? lowerQuantileThreshold,
      diagnostics: {},
    };
  }
  if (method === 'spot') {
    return {
      method,
      threshold: Number.NaN,
      lowerThreshold: lowerQuantileThreshold,
      diagnostics: {},
    };
  }
  if (method === 'otsu') {
    const otsu = computeOtsuLogThreshold(values);
    if (!otsu) {
      return {
        method,
        threshold: Number.NaN,
        lowerThreshold: lowerQuantileThreshold,
        diagnostics: { otsu: null },
      };
    }
    return {
      method,
      threshold: otsu.threshold,
      lowerThreshold: lowerQuantileThreshold,
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
      lowerThreshold: lowerQuantileThreshold,
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
  const targetQuantile = quantileUpper;
  return {
    method,
    threshold: computeQuantile(values, targetQuantile),
    lowerThreshold: lowerQuantileThreshold,
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
      thresholdLowerSeconds: 0,
      diagnostics: {
        method: DEFAULT_OPTIONS.method,
        baselineCount: 0,
        baselineMeanSeconds: null,
        baselineStdSeconds: null,
        baselineMinSeconds: null,
        baselineMaxSeconds: null,
        thresholdSeconds: 0,
        thresholdLowerSeconds: 0,
        fallbackApplied: false,
        quantile: null,
        otsu: null,
        knee: null,
        groupThresholds: {},
      },
    };
  }

  const mergedOptions: TimeDeviationOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  if (options.quantile !== undefined && options.quantile !== null) {
    mergedOptions.quantileUpper = options.quantile;
  }
  if (options.quantileLower !== undefined && options.quantileLower !== null) {
    mergedOptions.quantileLower = options.quantileLower;
  }

  const baselineSource = Array.isArray(mergedOptions.baselineSequence)
    ? mergedOptions.baselineSequence
    : sequence;
  const baselineDeltas = extractDeltaSeries(baselineSource).filter((value) => isFiniteNumber(value));
  const groupDeltaMap = new Map<string, { deltas: number[] }>();
  for (let index = 1; index < baselineSource.length; index += 1) {
    const current = baselineSource[index] ?? null;
    const previous = baselineSource[index - 1] ?? null;
    const delta = resolveDeltaSeconds(current, previous);
    if (!isFiniteNumber(delta)) {
      continue;
    }
    const currentUid = extractUid(current);
    const previousUid = extractUid(previous);
    const currentCategory = extractCategory(current);
    const previousCategory = extractCategory(previous);
    if (currentUid && previousUid && currentUid !== previousUid) {
      continue;
    }
    if (currentCategory && previousCategory && currentCategory !== previousCategory) {
      continue;
    }
    const uid = currentUid ?? previousUid;
    const category = currentCategory ?? previousCategory;
    const key = buildGroupKey(uid, category);
    const bucket = groupDeltaMap.get(key);
    if (bucket) {
      bucket.deltas.push(delta);
    } else {
      groupDeltaMap.set(key, { deltas: [delta] });
    }
  }
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
    thresholdLowerSeconds: 0,
    fallbackApplied: false,
    quantile: null,
    otsu: null,
    knee: null,
    groupThresholds: {},
  };

  let threshold = Number.NaN;
  let lowerThreshold = Number.NaN;
  let thresholdDiagnostics: Partial<TimeDeviationDiagnostics> = {};
  let fallbackApplied = false;
  const fallbackUpperCandidate = parseOptionalFiniteNumber(mergedOptions.fallbackThresholdSeconds);
  const fallbackLowerCandidate = parseOptionalFiniteNumber(
    mergedOptions.fallbackLowerThresholdSeconds ?? mergedOptions.lowerThresholdSeconds,
  );
  if (baselineDeltas.length >= minSamples) {
    const resolution = resolveThresholdDetailed(baselineDeltas, mergedOptions);
    threshold = resolution.threshold;
    lowerThreshold = resolution.lowerThreshold;
    thresholdDiagnostics = resolution.diagnostics;
    diagnosticsBase.method = resolution.method;
  } else {
    if (fallbackUpperCandidate !== null && fallbackUpperCandidate >= 0) {
      threshold = fallbackUpperCandidate;
      fallbackApplied = true;
    }
    if (fallbackLowerCandidate !== null && fallbackLowerCandidate >= 0) {
      lowerThreshold = fallbackLowerCandidate;
    }
  }

  if ((!isFiniteNumber(threshold) || !isFiniteNumber(lowerThreshold)) && baselineDeltas.length > 0) {
    const resolution = resolveThresholdDetailed(baselineDeltas, { ...mergedOptions, minSamples: 1 });
    if (!isFiniteNumber(threshold)) {
      threshold = resolution.threshold;
      thresholdDiagnostics = resolution.diagnostics;
      diagnosticsBase.method = resolution.method;
    }
    if (!isFiniteNumber(lowerThreshold)) {
      lowerThreshold = resolution.lowerThreshold;
    }
  }

  if (!isFiniteNumber(threshold) && fallbackUpperCandidate !== null && fallbackUpperCandidate >= 0) {
    threshold = fallbackUpperCandidate;
    fallbackApplied = true;
  }

  if (!isFiniteNumber(lowerThreshold)) {
    if (fallbackLowerCandidate !== null && fallbackLowerCandidate >= 0) {
      lowerThreshold = fallbackLowerCandidate;
    } else if (baselineDeltas.length > 0) {
      const quantileLowerValue = resolveQuantileValue(
        mergedOptions.quantileLower,
        DEFAULT_OPTIONS.quantileLower,
      );
      const estimatedLower = computeQuantile(baselineDeltas, quantileLowerValue);
      if (isFiniteNumber(estimatedLower)) {
        lowerThreshold = estimatedLower;
      }
    }
  }

  const normalizedGlobal = normalizeTauPair(
    threshold,
    lowerThreshold,
    fallbackUpperCandidate ?? 0,
    fallbackLowerCandidate ?? 0,
  );
  threshold = normalizedGlobal.tauHi;
  lowerThreshold = normalizedGlobal.tauLo;

  const groupThresholdsRecord: Record<string, GroupThresholdSummary> = {};
  for (const [key, bucket] of groupDeltaMap.entries()) {
    const { deltas } = bucket;
    let tauHi = Number.NaN;
    let tauLo = Number.NaN;
    let fallbackToGlobal = false;
    if (deltas.length >= minSamples) {
      const resolution = resolveThresholdDetailed(deltas, mergedOptions);
      tauHi = resolution.threshold;
      tauLo = resolution.lowerThreshold;
    }
    if (!Number.isFinite(tauHi) || deltas.length < minSamples) {
      tauHi = threshold;
      fallbackToGlobal = true;
    }
    if (!Number.isFinite(tauLo)) {
      tauLo = lowerThreshold;
    }
    const normalized = normalizeTauPair(tauHi, tauLo, threshold, lowerThreshold);
    groupThresholdsRecord[key] = {
      tauHiSeconds: normalized.tauHi,
      tauLoSeconds: normalized.tauLo,
      sampleCount: deltas.length,
      fallbackToGlobal,
    };
  }

  const diagnostics: TimeDeviationDiagnostics = {
    ...diagnosticsBase,
    thresholdSeconds: threshold,
    thresholdLowerSeconds: lowerThreshold,
    fallbackApplied,
    quantile: typeof thresholdDiagnostics.quantile === 'number' ? thresholdDiagnostics.quantile : diagnosticsBase.quantile,
    otsu: thresholdDiagnostics.otsu !== undefined ? (thresholdDiagnostics.otsu ?? null) : diagnosticsBase.otsu,
    knee: thresholdDiagnostics.knee !== undefined ? (thresholdDiagnostics.knee ?? null) : diagnosticsBase.knee,
    groupThresholds: groupThresholdsRecord,
  };

  const decorated: TimeDeviationEvent[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index] ?? null;
    const previous = index > 0 ? sequence[index - 1] ?? null : null;
    const isFirstEvent = index === 0;
    const observedDelta = isFirstEvent ? 0 : resolveDeltaSeconds(current, previous);
    const safeDelta = isFiniteNumber(observedDelta) ? observedDelta : 0;
    const currentUid = extractUid(current);
    const previousUid = extractUid(previous);
    const currentCategory = extractCategory(current);
    const previousCategory = extractCategory(previous);
    const uid = currentUid ?? previousUid;
    const category = currentCategory ?? previousCategory;
    const groupKey = buildGroupKey(uid, category);
    const groupThreshold = groupThresholdsRecord[groupKey];
    const normalizedGroup = normalizeTauPair(
      groupThreshold?.tauHiSeconds ?? threshold,
      groupThreshold?.tauLoSeconds ?? lowerThreshold,
      threshold,
      lowerThreshold,
    );
    const tauHi = normalizedGroup.tauHi;
    const tauLo = normalizedGroup.tauLo;
    const boundaryEvent =
      isFirstEvent
      || (currentUid && previousUid && currentUid !== previousUid)
      || (currentCategory && previousCategory && currentCategory !== previousCategory);
    const upperBreach = !boundaryEvent && safeDelta > tauHi;
    const lowerBreach = !boundaryEvent && safeDelta < tauLo;
    let score = 0;
    if (upperBreach) {
      score = safeDelta - tauHi;
    } else if (lowerBreach) {
      score = tauLo - safeDelta;
    }
    let sQ = 1;
    if (upperBreach) {
      sQ = safeDelta / Math.max(tauHi, 1e-9);
    } else if (lowerBreach) {
      sQ = Math.max(tauLo, 1e-9) / Math.max(safeDelta, 1e-9);
    }
    decorated.push({
      ...(current as Record<string, unknown>),
      timeDeviationObservedDeltaSeconds: safeDelta,
      timeDeviationThresholdSeconds: tauHi,
      timeDeviationThresholdLowerSeconds: tauLo,
      timeDeviationScore: score,
      timeDeviationFlag: upperBreach || lowerBreach,
      tau_hi: tauHi,
      tau_lo: tauLo,
      s_Q: sQ,
    });
  }

  return {
    events: decorated,
    thresholdSeconds: threshold,
    thresholdLowerSeconds: lowerThreshold,
    diagnostics,
  };
};

const timeDeviationDetector = {
  detectTimeDeviation,
  extractDeltaSeries,
  resolveThreshold,
};

export default timeDeviationDetector;
