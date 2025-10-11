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
