import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import config from '../../config';
import { labelSequence } from '../labeler';
import type { SimulationEvent } from '../../services/simulationService';

export type FeatureResolver = (
  event: SimulationEvent,
  index: number,
  events: SimulationEvent[],
  fallback: number | string | null,
) => number | string | null;

export interface FeatureOverrides {
  dt_sec?: FeatureResolver;
  log_dt?: FeatureResolver;
  z?: FeatureResolver;
  z_clipped?: FeatureResolver;
  z_robust?: FeatureResolver;
  z_robust_clipped?: FeatureResolver;
  z_hourly?: FeatureResolver;
  z_hourly_clipped?: FeatureResolver;
  time_label?: FeatureResolver;
  log_burst_mean?: FeatureResolver;
  log_burst_std?: FeatureResolver;
  log_burst_z?: FeatureResolver;
  log_burst_z_clipped?: FeatureResolver;
  [key: string]: FeatureResolver | undefined;
}

export interface PersistSimulationInput extends Record<string, unknown> {
  events: readonly SimulationEvent[];
  scenarioId?: string;
  seed?: string | null;
  runId?: string | null;
  outputDir?: string;
  csvFileName?: string;
  manifestFileName?: string;
  parameters?: Record<string, unknown>;
  sessionIds?: readonly string[];
  featureOverrides?: FeatureOverrides;
  manifest?: Record<string, unknown>;
  transitionTableVersion?: string | null;
  extraMetadata?: Record<string, unknown>;
}

export interface PersistSimulationResult {
  csvPath: string;
  manifestPath: string;
  runId: string;
  events: SimulationEvent[];
  manifest: Record<string, unknown>;
  hash: string;
}

export type AugmentedSimulationEvent = SimulationEvent & {
  dt_sec: number | null;
  log_dt: number | null;
  z: number | null;
  z_clipped: number | null;
  z_robust: number | null;
  z_robust_clipped: number | null;
  z_hourly: number | null;
  z_hourly_clipped: number | null;
  time_label: string | null;
  log_burst_mean: number | null;
  log_burst_std: number | null;
  log_burst_z: number | null;
  log_burst_z_clipped: number | null;
} & Record<string, unknown>;

export interface AugmentComputationOptions {
  epsilonT?: number;
  measurementEpsilon?: number;
  windowSize?: number;
  quantiles?: readonly number[];
  clipBounds?: Partial<Record<'z' | 'z_robust' | 'z_hourly' | 'log_burst_z', ClipBoundInput>>;
}

export interface FeatureAugmenterClipBounds {
  z: ClipBounds;
  z_robust: ClipBounds;
  z_hourly: ClipBounds;
  log_burst_z: ClipBounds;
}

export interface FeatureAugmenterOptions {
  windowSize: number;
  quantiles: number[];
  clipBounds: FeatureAugmenterClipBounds;
}

export type ClipBoundInput =
  | { min?: number; max?: number }
  | readonly [number, number]
  | number[]
  | number
  | null
  | undefined;

interface ClipBounds {
  min: number;
  max: number;
}

const EPSILON_MIN = 1e-6;
const EPSILON_MAX = 1e-2;
const GLOBAL_SESSION_KEY = '__global__';
const DEFAULT_WINDOW_SIZE = 12;
const DEFAULT_QUANTILES = Object.freeze([0.25, 0.5, 0.75]);
const MAD_TO_STD = 1.4826;
const DEFAULT_CLIP_BOUNDS: FeatureAugmenterClipBounds = {
  z: { min: -5, max: 5 },
  z_robust: { min: -5, max: 5 },
  z_hourly: { min: -5, max: 5 },
  log_burst_z: { min: -5, max: 5 },
};

const BASE_EXTRA_COLUMN_NAMES = [
  'dt_sec',
  'log_dt',
  'z',
  'z_clipped',
  'z_robust',
  'z_robust_clipped',
  'z_hourly',
  'z_hourly_clipped',
  'time_label',
  'log_burst_mean',
  'log_burst_std',
  'log_burst_z',
  'log_burst_z_clipped',
] as const;

const hasOwn = Object.prototype.hasOwnProperty;

const clamp = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Number.NaN;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
};

const cloneClipBounds = (bounds: ClipBounds): ClipBounds => ({ min: bounds.min, max: bounds.max });

const sanitizeClipTuple = (value: ClipBoundInput): ClipBounds | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const absolute = Math.abs(value);
    if (absolute === 0) {
      return null;
    }
    return { min: -absolute, max: absolute };
  }
  if (Array.isArray(value)) {
    const [first, second] = value;
    const min = Number(first);
    const max = Number(second);
    if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
      return { min, max };
    }
  }
  if (value && typeof value === 'object') {
    const candidateMin = Number((value as { min?: number }).min);
    const candidateMax = Number((value as { max?: number }).max);
    if (Number.isFinite(candidateMin) && Number.isFinite(candidateMax) && candidateMin < candidateMax) {
      return { min: candidateMin, max: candidateMax };
    }
  }
  return null;
};

const resolveClipBounds = (
  input?: Partial<Record<'z' | 'z_robust' | 'z_hourly' | 'log_burst_z', ClipBoundInput>>,
): FeatureAugmenterClipBounds => ({
  z: sanitizeClipTuple(input?.z) ?? cloneClipBounds(DEFAULT_CLIP_BOUNDS.z),
  z_robust: sanitizeClipTuple(input?.z_robust) ?? cloneClipBounds(DEFAULT_CLIP_BOUNDS.z_robust),
  z_hourly: sanitizeClipTuple(input?.z_hourly) ?? cloneClipBounds(DEFAULT_CLIP_BOUNDS.z_hourly),
  log_burst_z: sanitizeClipTuple(input?.log_burst_z) ?? cloneClipBounds(DEFAULT_CLIP_BOUNDS.log_burst_z),
});

const resolveWindowSize = (value: unknown): number => {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric;
  }
  return DEFAULT_WINDOW_SIZE;
};

const sanitizeQuantiles = (quantiles?: readonly number[]): number[] => {
  if (!Array.isArray(quantiles)) {
    return [...DEFAULT_QUANTILES];
  }
  const filtered = quantiles
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => {
      if (value < 0) {
        return 0;
      }
      if (value > 1) {
        return 1;
      }
      return value;
    });
  const unique = Array.from(new Set(filtered));
  if (unique.length === 0) {
    return [...DEFAULT_QUANTILES];
  }
  unique.sort((a, b) => a - b);
  return unique;
};

const quantileColumnName = (quantile: number): string => {
  const percent = quantile * 100;
  const normalized = Number.isFinite(percent)
    ? percent.toFixed(2).replace(/\.0+$/, '').replace('.', 'p')
    : '0';
  return `m_q${normalized}`;
};

const computeMedian = (values: readonly number[]): number | null => {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
};

const computeMad = (values: readonly number[], median: number | null): number => {
  if (median === null) {
    return 0;
  }
  const deviations = values.map((value) => Math.abs(value - median));
  const mad = computeMedian(deviations);
  return mad !== null ? mad : 0;
};

const computeQuantile = (sortedValues: readonly number[], quantile: number): number => {
  if (sortedValues.length === 0) {
    return Number.NaN;
  }
  if (quantile <= 0) {
    return sortedValues[0];
  }
  if (quantile >= 1) {
    return sortedValues[sortedValues.length - 1];
  }
  const position = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];
  if (lowerIndex === upperIndex) {
    return lowerValue;
  }
  const weight = position - lowerIndex;
  return lowerValue * (1 - weight) + upperValue * weight;
};

export const DEFAULT_FEATURE_AUGMENTER: FeatureAugmenterOptions = {
  windowSize: DEFAULT_WINDOW_SIZE,
  quantiles: [...DEFAULT_QUANTILES],
  clipBounds: {
    z: cloneClipBounds(DEFAULT_CLIP_BOUNDS.z),
    z_robust: cloneClipBounds(DEFAULT_CLIP_BOUNDS.z_robust),
    z_hourly: cloneClipBounds(DEFAULT_CLIP_BOUNDS.z_hourly),
    log_burst_z: cloneClipBounds(DEFAULT_CLIP_BOUNDS.log_burst_z),
  },
};

export const resolveFeatureAugmenterOptions = (
  input?: Partial<FeatureAugmenterOptions> | Record<string, unknown>,
): FeatureAugmenterOptions => {
  const windowSizeCandidate = (input as Record<string, unknown>)?.windowSize
    ?? (input as Record<string, unknown>)?.window_size;
  const quantilesCandidate = (input as Record<string, unknown>)?.quantiles;
  const clipCandidate = (input as Record<string, unknown>)?.clipBounds
    ?? (input as Record<string, unknown>)?.clip_bounds;
  const sanitizedQuantiles = sanitizeQuantiles(
    Array.isArray(quantilesCandidate) ? (quantilesCandidate as number[]) : undefined,
  );
  const resolvedClipBounds = resolveClipBounds(
    clipCandidate as Partial<Record<'z' | 'z_robust' | 'z_hourly' | 'log_burst_z', ClipBoundInput>> | undefined,
  );
  return {
    windowSize: resolveWindowSize(windowSizeCandidate),
    quantiles: sanitizedQuantiles,
    clipBounds: resolvedClipBounds,
  };
};

const resolveFeatureAugmenterFromInput = (
  input: PersistSimulationInput | null | undefined,
): FeatureAugmenterOptions => {
  const parameters = (input?.parameters ?? {}) as Record<string, unknown>;
  const parameterAugmenter = parameters.feature_augmenter ?? parameters.featureAugmenter;
  if (parameterAugmenter && typeof parameterAugmenter === 'object') {
    return resolveFeatureAugmenterOptions(parameterAugmenter as Record<string, unknown>);
  }
  const manifest = (input?.manifest ?? {}) as Record<string, unknown>;
  const manifestFeatures = (manifest.features ?? {}) as Record<string, unknown>;
  const manifestAugmenter = manifestFeatures.augmenter;
  if (manifestAugmenter && typeof manifestAugmenter === 'object') {
    return resolveFeatureAugmenterOptions(manifestAugmenter as Record<string, unknown>);
  }
  return cloneFeatureAugmenterOptions(DEFAULT_FEATURE_AUGMENTER);
};

const sanitizeNumeric = (value: unknown): number | null => {
  if (typeof value !== 'number') {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
};

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

const estimateMeasurementEpsilon = (events: readonly SimulationEvent[]): number => {
  let minPositive = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const delta = extractDeltaSeconds(event);
    if (typeof delta === 'number' && Number.isFinite(delta) && delta > 0) {
      if (delta < minPositive) {
        minPositive = delta;
      }
    }
  }
  if (!Number.isFinite(minPositive)) {
    return EPSILON_MIN;
  }
  const candidate = 0.5 * minPositive;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return EPSILON_MIN;
  }
  const clamped = Math.min(Math.max(candidate, EPSILON_MIN), EPSILON_MAX);
  return clamped;
};

const extractNumeric = (value: unknown): number | null => {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return null;
};

const resolveEpsilonT = (input: PersistSimulationInput | null | undefined, epsilon: number): number => {
  const parameters = (input?.parameters ?? {}) as Record<string, unknown>;
  const candidate = extractNumeric(parameters.epsilon_t ?? parameters.epsilonT);
  if (candidate !== null && candidate >= 0) {
    return candidate;
  }
  const manifest = (input?.manifest ?? {}) as Record<string, unknown>;
  const timing = (manifest.timing ?? {}) as Record<string, unknown>;
  const manifestCandidate = extractNumeric(timing.epsilon_t_seconds ?? timing.epsilonT);
  if (manifestCandidate !== null && manifestCandidate >= 0) {
    return manifestCandidate;
  }
  return epsilon;
};

const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/;

const parseOffsetFromTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.trim().match(OFFSET_PATTERN);
  if (!match) {
    return null;
  }
  const token = match[1];
  if (token === 'Z') {
    return 0;
  }
  const sign = token.startsWith('-') ? -1 : 1;
  const digits = token.replace(/[+\-]/, '').replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2) || '0');
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }
  return sign * (hours * 60 + minutes);
};

const resolveTimezoneOffsetSeconds = (events: readonly SimulationEvent[]): number => {
  for (const event of events) {
    const metadata = (event?.metadata ?? {}) as Record<string, unknown>;
    const direct = extractNumeric(metadata.timezone_offset_seconds);
    if (direct !== null) {
      return direct;
    }
    const nestedTiming = (metadata.timing ?? {}) as Record<string, unknown>;
    const nested = extractNumeric(nestedTiming.timezone_offset_seconds);
    if (nested !== null) {
      return nested;
    }
    const timestampOffset = parseOffsetFromTimestamp(event.timestamp || event.timestamp_utc);
    if (timestampOffset !== null) {
      return timestampOffset * 60;
    }
  }
  return 0;
};

const computeMeanAndStd = (values: readonly number[]): { mean: number; std: number } => {
  if (!Array.isArray(values) || values.length === 0) {
    return { mean: 0, std: 0 };
  }
  const count = values.length;
  const sum = values.reduce((acc, value) => acc + value, 0);
  const mean = sum / count;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / count;
  const std = Number.isFinite(variance) && variance > 0 ? Math.sqrt(variance) : 0;
  return { mean, std };
};

const normalizeTimeLabel = (value: unknown): 'initial' | 'measured' | 'unknown' => {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'initial') {
    return 'initial';
  }
  if (normalized === 'measured' || normalized === 'ok') {
    return 'measured';
  }
  return 'unknown';
};

const baseExtrasResolvers: Record<string, FeatureResolver | null> = BASE_EXTRA_COLUMN_NAMES.reduce(
  (accumulator, column) => {
    accumulator[column] = null;
    return accumulator;
  },
  {} as Record<string, FeatureResolver | null>,
);

const CSV_BASE_COLUMNS = [
  'timestamp',
  'timestamp_utc',
  'session_id',
  'user_id',
  'event',
  'method',
  'path',
  'status',
  'latency_ms',
  'delta_t',
  'metadata',
] as const;

const CSV_TRAILING_COLUMNS = ['sid_final'] as const;

const buildFeatureColumnList = (options: FeatureAugmenterOptions): string[] => [
  ...BASE_EXTRA_COLUMN_NAMES,
  ...options.quantiles.map((quantile) => quantileColumnName(quantile)),
];

export const cloneFeatureAugmenterOptions = (options: FeatureAugmenterOptions): FeatureAugmenterOptions => ({
  windowSize: options.windowSize,
  quantiles: [...options.quantiles],
  clipBounds: {
    z: cloneClipBounds(options.clipBounds.z),
    z_robust: cloneClipBounds(options.clipBounds.z_robust),
    z_hourly: cloneClipBounds(options.clipBounds.z_hourly),
    log_burst_z: cloneClipBounds(options.clipBounds.log_burst_z),
  },
});

export const augmentRows = <T extends SimulationEvent>(
  rows: readonly T[],
  extras: FeatureOverrides = {},
  options: AugmentComputationOptions = {},
): Array<T & AugmentedSimulationEvent> => {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const featureOptions = resolveFeatureAugmenterOptions(options as Record<string, unknown>);
  const quantileColumns = featureOptions.quantiles.map((quantile) => quantileColumnName(quantile));

  const resolvers: Record<string, FeatureResolver | null> = { ...baseExtrasResolvers };
  for (const column of quantileColumns) {
    resolvers[column] = null;
  }

  for (const column of Object.keys(resolvers)) {
    const resolver = extras[column];
    if (resolver !== undefined && typeof resolver !== 'function') {
      throw new TypeError(`${column} override must be a function when provided`);
    }
    if (resolver !== undefined) {
      resolvers[column] = resolver ?? null;
    }
  }

  const sanitizedRows = rows.map((event) =>
    event && typeof event === 'object' ? ({ ...event } as SimulationEvent) : ({}) as SimulationEvent,
  );

  const suppliedMeasurementEpsilon = options.measurementEpsilon;
  const measurementEpsilon = typeof suppliedMeasurementEpsilon === 'number' && suppliedMeasurementEpsilon > 0
    ? Math.min(Math.max(suppliedMeasurementEpsilon, EPSILON_MIN), EPSILON_MAX)
    : estimateMeasurementEpsilon(sanitizedRows);
  const suppliedEpsilonT = options.epsilonT;
  const epsilonT = typeof suppliedEpsilonT === 'number' && suppliedEpsilonT >= 0
    ? suppliedEpsilonT
    : measurementEpsilon;

  const sessionStates = new Map<string, { previousTimestamp: number | null; sequence: number }>();
  const dtValues: Array<number | null> = new Array(sanitizedRows.length).fill(null);
  const timeLabels: Array<'initial' | 'measured' | 'unknown'> = new Array(sanitizedRows.length).fill('unknown');
  const eventHours: Array<number | null> = new Array(sanitizedRows.length).fill(null);
  const hourlyBuckets = new Map<number, number[]>();

  for (let index = 0; index < sanitizedRows.length; index += 1) {
    const event = sanitizedRows[index];
    const resolver = resolvers.dt_sec;
    const fallbackDelta = sanitizeNumeric(extractDeltaSeconds(event));
    const resolvedDelta = resolver
      ? sanitizeNumeric(resolver(event, index, sanitizedRows, fallbackDelta))
      : fallbackDelta;
    const sessionId = typeof event.session_id === 'string' && event.session_id.trim().length > 0
      ? event.session_id
      : GLOBAL_SESSION_KEY;
    const timestamp = parseTimestamp(event.timestamp || event.timestamp_utc);
    const state = sessionStates.get(sessionId) || { previousTimestamp: null, sequence: 0 };
    eventHours[index] = timestamp ? timestamp.getUTCHours() : null;

    let dtSec: number | null = resolvedDelta !== null && resolvedDelta > 0 ? resolvedDelta : null;
    let label: 'initial' | 'measured' | 'unknown';

    if (!timestamp) {
      label = 'initial';
      state.previousTimestamp = null;
    } else if (state.sequence === 0 || state.previousTimestamp === null) {
      label = 'initial';
      dtSec = null;
      state.previousTimestamp = timestamp.getTime();
    } else {
      let deltaCandidate = dtSec;
      if (deltaCandidate === null) {
        const diffSeconds = (timestamp.getTime() - state.previousTimestamp) / 1000;
        if (Number.isFinite(diffSeconds) && diffSeconds >= 0) {
          deltaCandidate = diffSeconds;
        }
      }
      if (deltaCandidate === null || !Number.isFinite(deltaCandidate) || deltaCandidate < 0) {
        label = 'initial';
        dtSec = null;
        state.previousTimestamp = timestamp.getTime();
      } else {
        const adjusted = Math.max(deltaCandidate, measurementEpsilon);
        dtSec = adjusted;
        label = adjusted <= epsilonT ? 'unknown' : 'measured';
        state.previousTimestamp = timestamp.getTime();
      }
    }

    dtValues[index] = dtSec;
    timeLabels[index] = label;
    (event as Record<string, unknown>).deltaSeconds = dtSec;
    state.sequence += 1;
    sessionStates.set(sessionId, state);

    if (dtSec !== null && eventHours[index] !== null) {
      const hour = eventHours[index] as number;
      const bucket = hourlyBuckets.get(hour) ?? [];
      bucket.push(dtSec);
      hourlyBuckets.set(hour, bucket);
    }
  }

  const positiveDtValues = dtValues.filter((value): value is number => value !== null);
  const { mean, std } = computeMeanAndStd(positiveDtValues);
  const globalMedian = computeMedian(positiveDtValues);
  const globalMad = computeMad(positiveDtValues, globalMedian);

  const hourlyStats = new Map<number, { median: number; mad: number; mean: number; std: number }>();
  for (const [hour, values] of hourlyBuckets.entries()) {
    const { mean: hourMean, std: hourStd } = computeMeanAndStd(values);
    const hourMedian = computeMedian(values);
    const hourMad = computeMad(values, hourMedian);
    hourlyStats.set(hour, {
      median: hourMedian ?? 0,
      mad: hourMad,
      mean: hourMean,
      std: hourStd,
    });
  }

  const dtWindow: number[] = [];
  const logWindow: number[] = [];

  return sanitizedRows.map((event, index) => {
    const dtSec = dtValues[index];
    const logFallback = dtSec !== null && dtSec > 0 ? Math.log(dtSec) : null;
    const logResolver = resolvers.log_dt;
    const logDt = logResolver
      ? sanitizeNumeric(logResolver(event, index, sanitizedRows, logFallback)) ?? logFallback
      : logFallback;

    let zScore: number | null = null;
    if (dtSec !== null) {
      zScore = std > 0 ? (dtSec - mean) / std : 0;
    }
    const zResolver = resolvers.z;
    if (zResolver) {
      const override = zResolver(event, index, sanitizedRows, zScore);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        zScore = numeric;
      }
    }

    const zClipBounds = featureOptions.clipBounds.z;
    const clippedFallback = zScore === null ? null : clamp(zScore, zClipBounds.min, zClipBounds.max);
    const zClippedResolver = resolvers.z_clipped;
    const zClipped = zClippedResolver
      ? sanitizeNumeric(zClippedResolver(event, index, sanitizedRows, clippedFallback)) ?? clippedFallback
      : clippedFallback;

    let robustZ: number | null = null;
    if (dtSec !== null) {
      if (globalMedian !== null && globalMad > 0) {
        robustZ = (0.6744897501960817 * (dtSec - globalMedian)) / globalMad;
      } else if (globalMedian !== null) {
        robustZ = dtSec === globalMedian ? 0 : Math.sign(dtSec - globalMedian);
      }
    }
    const zRobustResolver = resolvers.z_robust;
    if (zRobustResolver) {
      const override = zRobustResolver(event, index, sanitizedRows, robustZ);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        robustZ = numeric;
      }
    }
    const robustClip = featureOptions.clipBounds.z_robust;
    const robustClippedFallback = robustZ === null ? null : clamp(robustZ, robustClip.min, robustClip.max);
    const zRobustClippedResolver = resolvers.z_robust_clipped;
    const zRobustClipped = zRobustClippedResolver
      ? sanitizeNumeric(zRobustClippedResolver(event, index, sanitizedRows, robustClippedFallback))
        ?? robustClippedFallback
      : robustClippedFallback;

    let hourlyZ: number | null = null;
    if (dtSec !== null && eventHours[index] !== null) {
      const stats = hourlyStats.get(eventHours[index] as number);
      if (stats) {
        const baseline = Number.isFinite(stats.median) ? stats.median : stats.mean;
        const denominator = stats.std > 0 ? stats.std : stats.mad > 0 ? stats.mad * MAD_TO_STD : 0;
        if (baseline !== undefined && Number.isFinite(baseline)) {
          if (denominator > 0) {
            hourlyZ = (dtSec - baseline) / denominator;
          } else {
            hourlyZ = dtSec === baseline ? 0 : Math.sign(dtSec - baseline);
          }
        }
      }
    }
    const zHourlyResolver = resolvers.z_hourly;
    if (zHourlyResolver) {
      const override = zHourlyResolver(event, index, sanitizedRows, hourlyZ);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        hourlyZ = numeric;
      }
    }
    const hourlyClip = featureOptions.clipBounds.z_hourly;
    const hourlyClippedFallback = hourlyZ === null ? null : clamp(hourlyZ, hourlyClip.min, hourlyClip.max);
    const zHourlyClippedResolver = resolvers.z_hourly_clipped;
    const zHourlyClipped = zHourlyClippedResolver
      ? sanitizeNumeric(zHourlyClippedResolver(event, index, sanitizedRows, hourlyClippedFallback))
        ?? hourlyClippedFallback
      : hourlyClippedFallback;

    if (dtSec !== null) {
      dtWindow.push(dtSec);
      if (dtWindow.length > featureOptions.windowSize) {
        dtWindow.shift();
      }
      const logValue = Math.log(Math.max(dtSec, measurementEpsilon));
      logWindow.push(logValue);
      if (logWindow.length > featureOptions.windowSize) {
        logWindow.shift();
      }
    }

    const sortedWindow = dtWindow.length > 0 ? [...dtWindow].sort((a, b) => a - b) : [];
    const quantileValues: Record<string, number | null> = {};
    for (let qIndex = 0; qIndex < quantileColumns.length; qIndex += 1) {
      const column = quantileColumns[qIndex];
      const quantile = featureOptions.quantiles[qIndex];
      const fallback = sortedWindow.length > 0 ? computeQuantile(sortedWindow, quantile) : null;
      const resolver = resolvers[column];
      const resolved = resolver
        ? sanitizeNumeric(resolver(event, index, sanitizedRows, fallback)) ?? fallback
        : fallback;
      quantileValues[column] = resolved;
    }

    let logBurstMean: number | null = null;
    let logBurstStd: number | null = null;
    let logBurstZ: number | null = null;
    if (logWindow.length > 0) {
      const { mean: windowLogMean, std: windowLogStd } = computeMeanAndStd(logWindow);
      logBurstMean = windowLogMean;
      logBurstStd = logWindow.length > 1 ? windowLogStd : 0;
      if (logDt !== null) {
        if (windowLogStd > 0) {
          logBurstZ = (logDt - windowLogMean) / windowLogStd;
        } else {
          logBurstZ = logDt === windowLogMean ? 0 : Math.sign(logDt - windowLogMean);
        }
      }
    }

    const logBurstMeanResolver = resolvers.log_burst_mean;
    if (logBurstMeanResolver) {
      const override = logBurstMeanResolver(event, index, sanitizedRows, logBurstMean);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        logBurstMean = numeric;
      }
    }

    const logBurstStdResolver = resolvers.log_burst_std;
    if (logBurstStdResolver) {
      const override = logBurstStdResolver(event, index, sanitizedRows, logBurstStd);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        logBurstStd = numeric;
      }
    }

    const logBurstZResolver = resolvers.log_burst_z;
    if (logBurstZResolver) {
      const override = logBurstZResolver(event, index, sanitizedRows, logBurstZ);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        logBurstZ = numeric;
      }
    }

    const logBurstClip = featureOptions.clipBounds.log_burst_z;
    const logBurstClippedFallback = logBurstZ === null ? null : clamp(logBurstZ, logBurstClip.min, logBurstClip.max);
    const logBurstZClippedResolver = resolvers.log_burst_z_clipped;
    const logBurstZClipped = logBurstZClippedResolver
      ? sanitizeNumeric(logBurstZClippedResolver(event, index, sanitizedRows, logBurstClippedFallback))
        ?? logBurstClippedFallback
      : logBurstClippedFallback;

    const labelFallback = timeLabels[index] ?? 'unknown';
    const labelResolver = resolvers.time_label;
    const labelOverride = labelResolver
      ? labelResolver(event, index, sanitizedRows, labelFallback)
      : null;
    const timeLabel = normalizeTimeLabel(labelOverride ?? labelFallback);

    return {
      ...(event as Record<string, unknown>),
      dt_sec: dtSec,
      log_dt: logDt,
      z: zScore,
      z_clipped: zClipped,
      z_robust: robustZ,
      z_robust_clipped: zRobustClipped,
      z_hourly: hourlyZ,
      z_hourly_clipped: zHourlyClipped,
      time_label: timeLabel,
      log_burst_mean: logBurstMean,
      log_burst_std: logBurstStd,
      log_burst_z: logBurstZ,
      log_burst_z_clipped: logBurstZClipped,
      ...quantileValues,
    } as T & AugmentedSimulationEvent;
  });
};

const toCsvField = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '""';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `"${value}"`;
  }
  if (typeof value === 'string') {
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  const serialized = JSON.stringify(value);
  const escaped = serialized.replace(/"/g, '""');
  return `"${escaped}"`;
};

const sanitizeRunId = (runId: unknown): string | null => {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return null;
  }
  const trimmed = runId.trim();
  return trimmed.replace(/[^a-zA-Z0-9_-]+/g, '-');
};

const generateRunId = (): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `sim-${timestamp}`;
};

const ensureDirectory = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

const extractDeltaSeconds = (event: SimulationEvent): number | null => {
  const candidates = [
    event.deltaSeconds,
    (event as Record<string, unknown>).delta_seconds,
    (event as Record<string, unknown>).delta_t,
    (event as Record<string, unknown>).deltaT,
    (event as Record<string, unknown>).delta,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
};

export const summarizeDeltas = (events: readonly SimulationEvent[]): Record<string, unknown> => {
  const deltas = events
    .map((event) => extractDeltaSeconds(event))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  if (deltas.length === 0) {
    return {
      count: 0,
      mean: null,
      median: null,
      stddev: null,
      min: null,
      max: null,
    };
  }

  const sum = deltas.reduce((acc, value) => acc + value, 0);
  const mean = sum / deltas.length;
  const variance = deltas.reduce((acc, value) => acc + (value - mean) ** 2, 0) / deltas.length;
  const stddev = Math.sqrt(variance);
  const middle = Math.floor(deltas.length / 2);
  const median = deltas.length % 2 === 0
    ? (deltas[middle - 1] + deltas[middle]) / 2
    : deltas[middle];

  return {
    count: deltas.length,
    mean,
    median,
    stddev,
    min: deltas[0],
    max: deltas[deltas.length - 1],
  };
};

export const buildAnomalySummary = (events: readonly SimulationEvent[]): Record<string, number> => {
  const summary: Record<string, number> = {};
  for (const event of events) {
    const label = typeof event.anomaly_type === 'string' ? event.anomaly_type : 'unknown';
    summary[label] = (summary[label] || 0) + 1;
  }
  return summary;
};

const computeSessionStats = (events: readonly SimulationEvent[]): { totalSessions: number; perSession: Record<string, number> } => {
  const sessionCounts = new Map<string, number>();
  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue;
    }
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null;
    if (!sessionId) {
      continue;
    }
    sessionCounts.set(sessionId, (sessionCounts.get(sessionId) || 0) + 1);
  }
  return {
    totalSessions: sessionCounts.size,
    perSession: Object.fromEntries(sessionCounts.entries()),
  };
};

const serializeMetadata = (metadata: unknown): Record<string, unknown> => {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  if (Array.isArray(metadata)) {
    return { value: metadata };
  }
  return metadata as Record<string, unknown>;
};

const resolveSidFinal = (event: SimulationEvent): unknown => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  if (hasOwn.call(event, 'sid_final')) {
    const explicit = (event as Record<string, unknown>).sid_final;
    if (explicit !== undefined && explicit !== null && explicit !== '') {
      return explicit;
    }
  }
  const candidate = event.session_id;
  if (candidate === undefined || candidate === null || candidate === '') {
    return candidate ?? null;
  }
  return candidate;
};

export const formatCsvAugmented = (
  event: AugmentedSimulationEvent,
  featureColumns: readonly string[],
): string => {
  const safeEvent = event && typeof event === 'object' ? event : ({} as AugmentedSimulationEvent);
  const metadata = serializeMetadata(safeEvent.metadata);
  const sidFinal = resolveSidFinal(safeEvent);
  const baseValues = [
    safeEvent.timestamp,
    safeEvent.timestamp_utc,
    safeEvent.session_id,
    safeEvent.user_id,
    safeEvent.event,
    safeEvent.method,
    safeEvent.path,
    safeEvent.status,
    safeEvent.latency_ms,
    extractDeltaSeconds(safeEvent),
    metadata,
  ];
  const featureValues = featureColumns.map((column) => (safeEvent as Record<string, unknown>)[column] ?? null);
  const row = [...baseValues, ...featureValues, sidFinal].map(toCsvField);
  return row.join(',');
};

const formatCsvRows = (
  events: readonly SimulationEvent[],
  extras?: FeatureOverrides,
  options?: AugmentComputationOptions,
): string => {
  const featureOptions = resolveFeatureAugmenterOptions(options as Record<string, unknown>);
  const featureColumns = buildFeatureColumnList(featureOptions);
  const augmented = augmentRows(events, extras ?? {}, {
    ...options,
    windowSize: featureOptions.windowSize,
    quantiles: featureOptions.quantiles,
    clipBounds: featureOptions.clipBounds,
  });
  const headerColumns = [...CSV_BASE_COLUMNS, ...featureColumns, ...CSV_TRAILING_COLUMNS];
  const rows = [headerColumns.join(',')];
  for (const event of augmented) {
    rows.push(formatCsvAugmented(event, featureColumns));
  }
  return rows.join('\n').concat('\n');
};

const defaultManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  scenario_id: overrides.scenario_id ?? null,
  generated_at: overrides.generated_at ?? new Date().toISOString(),
  seed: overrides.seed ?? null,
  transition_table_version: overrides.transition_table_version ?? null,
  run_id: overrides.run_id ?? generateRunId(),
  parameters: overrides.parameters ?? {},
  tags: overrides.tags ?? [],
  notes: overrides.notes ?? null,
});

export const persistSimulationRun = async (
  input: PersistSimulationInput,
): Promise<PersistSimulationResult> => {
  const events = Array.isArray(input?.events) ? (input.events as SimulationEvent[]) : [];
  if (events.length === 0) {
    throw new Error('persistSimulationRun requires a non-empty events array');
  }

  const labeled = labelSequence(events);
  const measurementEpsilon = estimateMeasurementEpsilon(labeled);
  const epsilonT = resolveEpsilonT(input, measurementEpsilon);
  const offsetSeconds = resolveTimezoneOffsetSeconds(labeled);
  const runId = sanitizeRunId(input?.runId) || generateRunId();
  const generatedAt = new Date().toISOString();
  const outputDir = input?.outputDir ? path.resolve(input.outputDir) : config.simLogRoot;
  const featureAugmenter = resolveFeatureAugmenterFromInput(input);

  await ensureDirectory(outputDir);

  const csvFileName = input?.csvFileName || `simEvents-${runId}.csv`;
  const manifestFileName = input?.manifestFileName || `scenario-${runId}.json`;
  const csvPath = path.join(outputDir, csvFileName);
  const manifestPath = path.join(outputDir, manifestFileName);

  const csvContent = formatCsvRows(labeled, input?.featureOverrides, {
    epsilonT,
    measurementEpsilon,
    windowSize: featureAugmenter.windowSize,
    quantiles: featureAugmenter.quantiles,
    clipBounds: featureAugmenter.clipBounds,
  });
  await fs.writeFile(csvPath, csvContent, { encoding: 'utf8' });

  const hash = crypto.createHash('sha256').update(csvContent, 'utf8').digest('hex');
  const sessionStats = computeSessionStats(labeled);
  const deltaStats = summarizeDeltas(labeled);
  const anomalySummary = buildAnomalySummary(labeled);
  const totalAnomalies = Object.entries(anomalySummary)
    .filter(([label]) => label !== 'normal')
    .reduce((acc, [, count]) => acc + count, 0);

  const manifest = {
    ...defaultManifest({
      scenario_id: input?.scenarioId ?? input?.manifest?.scenario_id,
      generated_at: generatedAt,
      seed: input?.seed ?? input?.manifest?.seed,
      transition_table_version:
        input?.transitionTableVersion ?? input?.manifest?.transition_table_version ?? null,
      run_id: runId,
      parameters: input?.parameters ?? input?.manifest?.parameters ?? {},
      tags: input?.tags ?? input?.manifest?.tags ?? [],
      notes: input?.notes ?? input?.manifest?.notes ?? null,
    }),
    counts: {
      events: labeled.length,
      sessions: sessionStats.totalSessions,
      anomalies: totalAnomalies,
    },
    anomaly_summary: anomalySummary,
    delta_seconds: deltaStats,
    session_event_counts: sessionStats.perSession,
    output: {
      csv_path: csvPath,
      manifest_path: manifestPath,
      csv_sha256: hash,
    },
    source: {
      sim_log_dir: outputDir,
    },
  } as Record<string, unknown>;

  const existingTiming = (manifest.timing ?? {}) as Record<string, unknown>;
  manifest.timing = {
    ...existingTiming,
    epsilon_seconds: measurementEpsilon,
    epsilon_t_seconds: epsilonT,
    timezone_offset_seconds: offsetSeconds,
  };

  const featuresSection = (manifest.features ?? {}) as Record<string, unknown>;
  const augmenterClone = cloneFeatureAugmenterOptions(featureAugmenter);
  featuresSection.augmenter = {
    window_size: augmenterClone.windowSize,
    quantiles: [...augmenterClone.quantiles],
    clip_bounds: {
      z: cloneClipBounds(augmenterClone.clipBounds.z),
      z_robust: cloneClipBounds(augmenterClone.clipBounds.z_robust),
      z_hourly: cloneClipBounds(augmenterClone.clipBounds.z_hourly),
      log_burst_z: cloneClipBounds(augmenterClone.clipBounds.log_burst_z),
    },
  };
  manifest.features = featuresSection;

  if (Array.isArray(input?.sessionIds) && input.sessionIds.length > 0) {
    manifest.session_ids = Array.from(new Set(input.sessionIds));
  } else {
    const derivedSessions = Object.keys(sessionStats.perSession);
    if (derivedSessions.length > 0) {
      manifest.session_ids = derivedSessions;
    }
  }

  if (input?.transitionTableVersion) {
    manifest.transition_table_version = input.transitionTableVersion;
  }

  if (input?.extraMetadata && typeof input.extraMetadata === 'object') {
    manifest.extra = { ...input.extraMetadata };
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
  });

  return {
    csvPath,
    manifestPath,
    runId,
    events: labeled,
    manifest,
    hash,
  };
};

const simWriter = {
  persistSimulationRun,
  summarizeDeltas,
  buildAnomalySummary,
  augmentRows,
  formatCsvAugmented,
};

export default simWriter;
