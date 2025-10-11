import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';

export const algoVersion = "otsu+kneedle-v1" as const;

export type SplitReason =
  | "initial"
  | "continuous"
  | "idle_timeout"
  | "timestamp_regression"
  | "session_id_change";

export interface SessionSplitOptions {
  idleTimeoutSeconds?: number;
  timestampColumn?: string;
  userIdColumn?: string;
  sessionIdColumn?: string;
}

export interface ThresholdEstimationOptions {
  minimumSamples?: number;
  fallbackPercentile?: number;
}

export interface LogHistogramOptions {
  minBinCount?: number;
  maxBinCount?: number;
  decimals?: number;
  logBase?: number;
}

export interface LogHistogramResult {
  binEdges: number[];
  binCounts: number[];
  binCount: number;
  logBinWidth: number;
  domain: {
    min: number;
    max: number;
    logMin: number;
    logMax: number;
  };
}

export interface AugmentedRow {
  algo_ver: typeof algoVersion;
  uid: string;
  generatedSessionId: string;
  sessionSequence: number;
  sessionIndex: number;
  timestampUtc: string;
  deltaSeconds: number | null;
  idleTimeoutSeconds: number;
  splitReason: SplitReason;
  originalSessionId?: string;
  original: Record<string, string>;
}

export type ThresholdMap = Map<string, number> & { readonly algo_ver: typeof algoVersion };

interface SessionTracker {
  counter: number;
  generatedSessionId: string;
  sessionStartMs: number;
  lastTimestampMs: number;
  sessionIndex: number;
  lastOriginalSessionId?: string;
}

interface NormalizedOptions {
  idleTimeoutSeconds: number;
  timestampColumn: string;
  userIdColumn: string;
  sessionIdColumn?: string;
}

interface NormalizedLogHistogramOptions {
  minBinCount: number;
  maxBinCount: number;
  decimals: number;
  logBase: number;
}

const LOG_HISTOGRAM_DEFAULTS: NormalizedLogHistogramOptions = {
  minBinCount: 32,
  maxBinCount: 512,
  decimals: 9,
  logBase: Math.E
};

export class SessionSplitterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SessionSplitterError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

const DEFAULT_OPTIONS: NormalizedOptions = {
  idleTimeoutSeconds: 1800,
  timestampColumn: "timestamp_utc",
  userIdColumn: "uid"
};

function normalizeOptions(options: SessionSplitOptions = {}): NormalizedOptions {
  return {
    idleTimeoutSeconds: options.idleTimeoutSeconds ?? DEFAULT_OPTIONS.idleTimeoutSeconds,
    timestampColumn: options.timestampColumn ?? DEFAULT_OPTIONS.timestampColumn,
    userIdColumn: options.userIdColumn ?? DEFAULT_OPTIONS.userIdColumn,
    sessionIdColumn: options.sessionIdColumn
  };
}

function normalizeLogHistogramOptions(
  options: LogHistogramOptions = {}
): NormalizedLogHistogramOptions {
  const minCandidate = Math.floor(options.minBinCount ?? LOG_HISTOGRAM_DEFAULTS.minBinCount);
  const maxCandidate = Math.floor(options.maxBinCount ?? LOG_HISTOGRAM_DEFAULTS.maxBinCount);
  const decimalsCandidate = Math.floor(options.decimals ?? LOG_HISTOGRAM_DEFAULTS.decimals);
  const logBaseCandidate = options.logBase ?? LOG_HISTOGRAM_DEFAULTS.logBase;

  const clippedMin = Math.min(
    LOG_HISTOGRAM_DEFAULTS.maxBinCount,
    Math.max(LOG_HISTOGRAM_DEFAULTS.minBinCount, Math.max(1, minCandidate))
  );
  const clippedMax = Math.min(
    LOG_HISTOGRAM_DEFAULTS.maxBinCount,
    Math.max(clippedMin, Math.max(1, maxCandidate))
  );
  const decimals = Math.min(12, Math.max(0, decimalsCandidate));
  const logBase = logBaseCandidate > 1 ? logBaseCandidate : LOG_HISTOGRAM_DEFAULTS.logBase;

  return {
    minBinCount: clippedMin,
    maxBinCount: clippedMax,
    decimals,
    logBase
  };
}

function ensureReadable(input: string | Readable): Readable {
  if (typeof input === "string") {
    return createReadStream(input, { encoding: "utf8" });
  }
  return input;
}

function startNewSession(
  userId: string,
  timestampMs: number,
  tracker: SessionTracker | undefined,
  originalSessionId: string | undefined
): SessionTracker {
  const nextCounter = tracker ? tracker.counter + 1 : 0;
  return {
    counter: nextCounter,
    generatedSessionId: `${userId}#${nextCounter}`,
    sessionStartMs: timestampMs,
    lastTimestampMs: timestampMs,
    sessionIndex: 0,
    lastOriginalSessionId: originalSessionId
  };
}

function updateExistingSession(
  tracker: SessionTracker,
  timestampMs: number,
  originalSessionId: string | undefined
): SessionTracker {
  return {
    ...tracker,
    sessionIndex: tracker.sessionIndex + 1,
    lastTimestampMs: timestampMs,
    lastOriginalSessionId: originalSessionId
  };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseTimestamp(value: string, column: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new SessionSplitterError(`Invalid timestamp in column ${column}: ${value}`);
  }
  return parsed;
}

export async function* splitSessions(
  csvStreamOrPath: string | Readable,
  options: SessionSplitOptions = {}
): AsyncGenerator<AugmentedRow> {
  const normalized = normalizeOptions(options);
  const stream = ensureReadable(csvStreamOrPath);
  const parser = parse({
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true
  });
  const pipeline = stream.pipe(parser);
  const trackers = new Map<string, SessionTracker>();

  try {
    for await (const record of pipeline as AsyncIterable<Record<string, string>>) {
      const uid = record[normalized.userIdColumn];
      if (!uid) {
        throw new SessionSplitterError(
          `Missing user identifier in column ${normalized.userIdColumn}`
        );
      }
      const timestampValue = record[normalized.timestampColumn];
      if (!timestampValue) {
        throw new SessionSplitterError(
          `Missing timestamp in column ${normalized.timestampColumn}`
        );
      }
      const timestampMs = parseTimestamp(timestampValue, normalized.timestampColumn);
      const tracker = trackers.get(uid);
      const originalSessionId = normalized.sessionIdColumn
        ? record[normalized.sessionIdColumn]
        : undefined;

      let splitReason: SplitReason = "continuous";
      let nextTracker: SessionTracker;
      let deltaSeconds: number | null = null;

      if (!tracker) {
        nextTracker = startNewSession(uid, timestampMs, tracker, originalSessionId);
        splitReason = "initial";
      } else {
        deltaSeconds = (timestampMs - tracker.lastTimestampMs) / 1000;
        const idleTimeout = normalized.idleTimeoutSeconds;
        const sessionIdChanged =
          normalized.sessionIdColumn &&
          tracker.lastOriginalSessionId !== undefined &&
          originalSessionId !== tracker.lastOriginalSessionId;

        if (deltaSeconds < 0) {
          splitReason = "timestamp_regression";
          nextTracker = startNewSession(uid, timestampMs, tracker, originalSessionId);
          deltaSeconds = null;
        } else if (deltaSeconds > idleTimeout) {
          splitReason = "idle_timeout";
          nextTracker = startNewSession(uid, timestampMs, tracker, originalSessionId);
          deltaSeconds = null;
        } else if (sessionIdChanged) {
          splitReason = "session_id_change";
          nextTracker = startNewSession(uid, timestampMs, tracker, originalSessionId);
          deltaSeconds = null;
        } else {
          nextTracker = updateExistingSession(tracker, timestampMs, originalSessionId);
        }
      }

      trackers.set(uid, nextTracker);

      const row: AugmentedRow = {
        algo_ver: algoVersion,
        uid,
        generatedSessionId: nextTracker.generatedSessionId,
        sessionSequence: nextTracker.counter,
        sessionIndex: nextTracker.sessionIndex,
        timestampUtc: toIso(timestampMs),
        deltaSeconds,
        idleTimeoutSeconds: normalized.idleTimeoutSeconds,
        splitReason,
        originalSessionId,
        original: record
      };

      yield row;
    }
  } catch (error) {
    if (error instanceof SessionSplitterError) {
      throw error;
    }
    throw new SessionSplitterError("Failed to split sessions", error);
  } finally {
    const destroy = (stream as { destroy?: () => void }).destroy;
    if (typeof destroy === "function") {
      destroy.call(stream);
    }
  }
}

export function estimateThresholdsByUser(
  rows: Iterable<AugmentedRow>,
  options: ThresholdEstimationOptions = {}
): ThresholdMap {
  const { minimumSamples = 5, fallbackPercentile = 0.95 } = options;
  const perUser = new Map<string, number[]>();

  for (const row of rows) {
    if (row.deltaSeconds === null || !Number.isFinite(row.deltaSeconds)) {
      continue;
    }
    if (row.deltaSeconds <= 0) {
      continue;
    }
    const list = perUser.get(row.uid) ?? [];
    list.push(row.deltaSeconds);
    perUser.set(row.uid, list);
  }

  const result = new Map<string, number>() as ThresholdMap;
  Object.defineProperty(result, "algo_ver", {
    value: algoVersion,
    enumerable: true,
    configurable: false,
    writable: false
  });

  for (const [uid, deltas] of perUser.entries()) {
    if (deltas.length === 0) {
      continue;
    }
    deltas.sort((a, b) => a - b);
    let threshold: number;
    if (deltas.length < minimumSamples) {
      threshold = percentile(deltas, fallbackPercentile);
    } else {
      const otsu = otsuThreshold(deltas);
      const kneedle = kneedleThreshold(deltas);
      const quantile = percentile(deltas, fallbackPercentile);
      threshold = Math.max(otsu, kneedle, quantile);
    }
    result.set(uid, threshold);
  }

  return result;
}

export function makeLogHistogram(
  userLogDeltas: Iterable<number>,
  options: LogHistogramOptions = {}
): LogHistogramResult {
  const normalized = normalizeLogHistogramOptions(options);
  const values = collectPositiveFinite(userLogDeltas);
  if (values.length === 0) {
    return {
      binEdges: [],
      binCounts: [],
      binCount: 0,
      logBinWidth: 0,
      domain: { min: Number.NaN, max: Number.NaN, logMin: Number.NaN, logMax: Number.NaN }
    };
  }

  values.sort((a, b) => a - b);
  const rawMin = values[0];
  const rawMax = values[values.length - 1];
  const roundedMin = roundMinBoundary(rawMin, normalized.decimals);
  const roundedMax = roundMaxBoundary(rawMax, normalized.decimals);

  const logValues = values.map((value) => logWithBase(value, normalized.logBase)).sort((a, b) => a - b);
  const effectiveMin = roundedMin > 0 ? roundedMin : rawMin;
  const logMin = logWithBase(effectiveMin, normalized.logBase);
  const logMax = logWithBase(roundedMax, normalized.logBase);

  if (!Number.isFinite(logMin) || !Number.isFinite(logMax) || logMax <= logMin) {
    const singleEdgeMin = effectiveMin;
    const singleEdgeMax = roundedMax;
    return {
      binEdges: [singleEdgeMin, singleEdgeMax],
      binCounts: [values.length],
      binCount: 1,
      logBinWidth: 0,
      domain: { min: singleEdgeMin, max: singleEdgeMax, logMin, logMax }
    };
  }

  const layout = computeFreedmanLayout(logValues, logMin, logMax, normalized);
  const binEdges = buildLogEdges(logMin, layout.logBinWidth, layout.binCount, normalized, effectiveMin, roundedMax);
  const binCounts = computeHistogramCounts(values, binEdges);

  return {
    binEdges,
    binCounts,
    binCount: layout.binCount,
    logBinWidth: layout.logBinWidth,
    domain: {
      min: binEdges[0],
      max: binEdges[binEdges.length - 1],
      logMin,
      logMax
    }
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  const position = clampedFraction * (values.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return values[lowerIndex];
  }
  const weight = position - lowerIndex;
  return values[lowerIndex] * (1 - weight) + values[upperIndex] * weight;
}

function otsuThreshold(sortedValues: number[]): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  if (min === max) {
    return max;
  }
  const binCount = Math.min(256, Math.max(2, Math.floor(Math.sqrt(sortedValues.length))));
  const histogram = new Array<number>(binCount).fill(0);
  const range = max - min;
  const binWidth = range === 0 ? 1 : range / binCount;

  for (const value of sortedValues) {
    const index = range === 0 ? 0 : Math.min(binCount - 1, Math.floor((value - min) / binWidth));
    histogram[index] += 1;
  }

  const total = sortedValues.length;
  let sumAll = 0;
  for (let i = 0; i < binCount; i += 1) {
    const center = min + (i + 0.5) * binWidth;
    sumAll += histogram[i] * center;
  }

  let sumB = 0;
  let wB = 0;
  let maxVariance = -Infinity;
  let threshold = min;

  for (let i = 0; i < binCount; i += 1) {
    wB += histogram[i];
    if (wB === 0) {
      continue;
    }
    const wF = total - wB;
    if (wF === 0) {
      break;
    }
    const center = min + (i + 0.5) * binWidth;
    sumB += histogram[i] * center;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const variance = wB * wF * (mB - mF) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = center;
    }
  }

  return threshold;
}

function kneedleThreshold(sortedValues: number[]): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  if (min === max) {
    return max;
  }
  let maxDiff = -Infinity;
  let selected = max;
  const denominator = sortedValues.length - 1;
  for (let i = 0; i < sortedValues.length; i += 1) {
    const normalizedIndex = denominator === 0 ? 0 : i / denominator;
    const normalizedValue = (sortedValues[i] - min) / (max - min);
    const diff = normalizedValue - normalizedIndex;
    if (diff > maxDiff) {
      maxDiff = diff;
      selected = sortedValues[i];
    }
  }
  return selected;
}

function collectPositiveFinite(values: Iterable<number>): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (typeof value !== "number") {
      continue;
    }
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    result.push(value);
  }
  return result;
}

function computeFreedmanLayout(
  sortedLogValues: number[],
  logMin: number,
  logMax: number,
  options: NormalizedLogHistogramOptions
): { binCount: number; logBinWidth: number } {
  const range = logMax - logMin;
  if (!(range > 0)) {
    return { binCount: 1, logBinWidth: range };
  }
  const q1 = quantileFromSorted(sortedLogValues, 0.25);
  const q3 = quantileFromSorted(sortedLogValues, 0.75);
  const iqr = q3 - q1;
  const n = sortedLogValues.length;
  const denominator = Math.cbrt(n);
  let width = iqr > 0 && Number.isFinite(iqr) && denominator > 0 ? (2 * iqr) / denominator : Number.NaN;
  if (!(width > 0) || !Number.isFinite(width)) {
    width = range / options.maxBinCount;
  }
  let estimated = Math.ceil(range / width);
  if (!Number.isFinite(estimated) || estimated <= 0) {
    estimated = options.maxBinCount;
  }
  const binCount = clampBinCount(estimated, options);
  const logBinWidth = range / binCount;
  return { binCount, logBinWidth };
}

function clampBinCount(value: number, options: NormalizedLogHistogramOptions): number {
  const integer = Math.max(1, Math.floor(value));
  const upper = Math.min(options.maxBinCount, LOG_HISTOGRAM_DEFAULTS.maxBinCount);
  const lower = Math.max(options.minBinCount, LOG_HISTOGRAM_DEFAULTS.minBinCount);
  return Math.min(upper, Math.max(lower, integer));
}

function quantileFromSorted(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  const position = clamped * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function buildLogEdges(
  logMin: number,
  logBinWidth: number,
  binCount: number,
  options: NormalizedLogHistogramOptions,
  minEdge: number,
  maxEdge: number
): number[] {
  const edges = new Array<number>(binCount + 1);
  for (let i = 0; i <= binCount; i += 1) {
    const logValue = logMin + logBinWidth * i;
    edges[i] = powWithBase(logValue, options.logBase);
  }
  const minRounded = roundMinBoundary(minEdge, options.decimals);
  edges[0] = minRounded > 0 ? minRounded : minEdge;
  const minStep = options.decimals > 0 ? 1 / 10 ** options.decimals : Number.EPSILON;
  for (let i = 1; i < edges.length - 1; i += 1) {
    const rounded = roundFixed(edges[i], options.decimals);
    edges[i] = rounded > edges[i - 1] ? rounded : roundFixed(edges[i - 1] + minStep, options.decimals);
  }
  const lastIndex = edges.length - 1;
  const roundedMax = roundMaxBoundary(maxEdge, options.decimals);
  const candidateMax = Math.max(roundedMax, edges[lastIndex - 1] + minStep);
  edges[lastIndex] = roundFixed(candidateMax, options.decimals);
  return edges;
}

function computeHistogramCounts(sortedValues: number[], edges: number[]): number[] {
  if (edges.length <= 1) {
    return sortedValues.length > 0 ? [sortedValues.length] : [];
  }
  const counts = new Array<number>(edges.length - 1).fill(0);
  let index = 0;
  for (const value of sortedValues) {
    while (index < counts.length - 1 && value >= edges[index + 1]) {
      index += 1;
    }
    counts[index] += 1;
  }
  return counts;
}

function roundFixed(value: number, decimals: number): number {
  if (decimals <= 0) {
    return Math.round(value);
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundMinBoundary(value: number, decimals: number): number {
  if (decimals <= 0) {
    return Math.floor(value);
  }
  const factor = 10 ** decimals;
  const rounded = Math.floor(value * factor) / factor;
  return rounded > 0 ? rounded : value;
}

function roundMaxBoundary(value: number, decimals: number): number {
  if (decimals <= 0) {
    return Math.ceil(value);
  }
  const factor = 10 ** decimals;
  const rounded = Math.ceil(value * factor) / factor;
  return rounded;
}

function logWithBase(value: number, base: number): number {
  return Math.log(value) / Math.log(base);
}

function powWithBase(exponent: number, base: number): number {
  return base === Math.E ? Math.exp(exponent) : base ** exponent;
}
