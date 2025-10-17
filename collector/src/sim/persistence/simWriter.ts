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
  time_label?: FeatureResolver;
  z_robust?: FeatureResolver;
  z_hourly?: FeatureResolver;
  log_burst_delta?: FeatureResolver;
  log_burst_flag?: FeatureResolver;
  [key: string]: FeatureResolver | undefined;
}

export interface FeatureClipBoundsInput {
  min?: number;
  max?: number;
  lower?: number;
  upper?: number;
}

export interface FeatureComputationOptions {
  windowSize?: number;
  clipBounds?: FeatureClipBoundsInput;
  quantiles?: number[];
  logBurstThreshold?: number;
}

export interface NormalizedFeatureComputationOptions {
  windowSize: number;
  clipBounds: { min: number; max: number };
  quantiles: number[];
  quantileLabels: string[];
  logBurstThreshold: number;
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
  featureOptions?: FeatureComputationOptions | NormalizedFeatureComputationOptions;
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
  time_label: string | null;
  z_robust: number | null;
  z_hourly: number | null;
  log_burst_delta: number | null;
  log_burst_flag: number | null;
};

const BASE_HEADER_COLUMNS = [
  'timestamp',
  'session_id',
  'user_id',
  'event',
  'method',
  'path',
  'status',
  'latency_ms',
  'delta_t',
  'metadata',
];

const BASE_FEATURE_COLUMNS = [
  'dt_sec',
  'log_dt',
  'z',
  'z_clipped',
  'time_label',
  'z_robust',
  'z_hourly',
  'log_burst_delta',
  'log_burst_flag',
] as const;

const MAD_SCALE = 1.4826;

const FEATURE_DEFAULTS: Required<FeatureComputationOptions> = {
  windowSize: 8,
  clipBounds: { min: -5, max: 5 },
  quantiles: [0.5, 0.9, 0.99],
  logBurstThreshold: Math.log(2),
};

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

const sanitizeNumeric = (value: unknown): number | null => {
  if (typeof value !== 'number') {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
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

const normalizeLabel = (value: unknown): string => {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed === 'ok' ? 'ok' : 'unknown';
};

const extrasResolvers: Record<string, FeatureResolver | null> = {
  dt_sec: null,
  log_dt: null,
  z: null,
  z_clipped: null,
  time_label: null,
  z_robust: null,
  z_hourly: null,
  log_burst_delta: null,
  log_burst_flag: null,
};

const isNormalizedFeatureOptions = (
  options: FeatureComputationOptions | NormalizedFeatureComputationOptions | undefined,
): options is NormalizedFeatureComputationOptions => {
  return !!options && Array.isArray((options as NormalizedFeatureComputationOptions).quantileLabels);
};

const formatQuantileLabel = (quantile: number): string => {
  const normalized = quantile
    .toFixed(3)
    .replace(/0+$/u, '')
    .replace(/\.$/u, '')
    .replace('.', '_');
  return `m_q_${normalized}`;
};

export const normalizeFeatureOptions = (
  options?: FeatureComputationOptions | NormalizedFeatureComputationOptions,
): NormalizedFeatureComputationOptions => {
  if (isNormalizedFeatureOptions(options)) {
    return options;
  }

  const windowCandidate = Math.floor(Number(options?.windowSize));
  const windowSize = Number.isFinite(windowCandidate) && windowCandidate > 0
    ? windowCandidate
    : FEATURE_DEFAULTS.windowSize;

  const clipInput = options?.clipBounds ?? {};
  const clipMinCandidate = Number((clipInput as FeatureClipBoundsInput).min ?? (clipInput as FeatureClipBoundsInput).lower);
  const clipMaxCandidate = Number((clipInput as FeatureClipBoundsInput).max ?? (clipInput as FeatureClipBoundsInput).upper);
  const defaultMin = FEATURE_DEFAULTS.clipBounds.min as number;
  const defaultMax = FEATURE_DEFAULTS.clipBounds.max as number;
  const clipMin = Number.isFinite(clipMinCandidate) ? (clipMinCandidate as number) : defaultMin;
  const clipMax = Number.isFinite(clipMaxCandidate) ? (clipMaxCandidate as number) : defaultMax;
  const normalizedClip = clipMin < clipMax ? { min: clipMin, max: clipMax } : { min: defaultMin, max: defaultMax };

  const quantileSource = Array.isArray(options?.quantiles)
    ? options?.quantiles ?? []
    : FEATURE_DEFAULTS.quantiles;
  const quantiles = Array.from(
    new Set(
      (quantileSource as number[])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0 && value < 1),
    ),
  ).sort((a, b) => a - b);
  const resolvedQuantiles = quantiles.length > 0 ? quantiles : FEATURE_DEFAULTS.quantiles;
  const quantileLabels = resolvedQuantiles.map((value) => formatQuantileLabel(value));

  const thresholdCandidate = Number(options?.logBurstThreshold);
  const logBurstThreshold = Number.isFinite(thresholdCandidate)
    ? (thresholdCandidate as number)
    : FEATURE_DEFAULTS.logBurstThreshold;

  return {
    windowSize,
    clipBounds: normalizedClip,
    quantiles: resolvedQuantiles,
    quantileLabels,
    logBurstThreshold,
  };
};

const DEFAULT_NORMALIZED_FEATURE_OPTIONS = normalizeFeatureOptions(FEATURE_DEFAULTS);

const computeMedianFromSorted = (values: readonly number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[middle - 1] + values[middle]) / 2;
  }
  return values[middle];
};

const computeMedianAndMad = (
  values: readonly number[],
): { median: number | null; scaledMad: number | null } => {
  if (values.length === 0) {
    return { median: null, scaledMad: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const median = computeMedianFromSorted(sorted);
  if (median === null) {
    return { median: null, scaledMad: null };
  }
  const deviations = sorted.map((value) => Math.abs(value - median));
  const mad = computeMedianFromSorted(deviations);
  if (mad === null || mad === 0) {
    return { median, scaledMad: 0 };
  }
  return { median, scaledMad: mad * MAD_SCALE };
};

const computeHourlyStats = (
  events: readonly SimulationEvent[],
  dtValues: readonly (number | null)[],
): Record<number, { median: number | null; scaledMad: number | null }> => {
  const perHour: Record<number, number[]> = {};
  for (let index = 0; index < events.length; index += 1) {
    const dt = dtValues[index];
    if (dt === null) {
      continue;
    }
    const event = events[index];
    const timestampRaw = typeof event.timestamp === 'string'
      ? event.timestamp
      : (event as Record<string, unknown>).timestamp_utc;
    if (typeof timestampRaw !== 'string') {
      continue;
    }
    const parsed = new Date(timestampRaw);
    if (Number.isNaN(parsed.getTime())) {
      continue;
    }
    const hour = parsed.getUTCHours();
    if (!perHour[hour]) {
      perHour[hour] = [];
    }
    perHour[hour].push(dt);
  }

  const result: Record<number, { median: number | null; scaledMad: number | null }> = {};
  for (const [key, values] of Object.entries(perHour)) {
    const hour = Number(key);
    result[hour] = computeMedianAndMad(values);
  }
  return result;
};

const computeQuantileFromSorted = (sorted: readonly number[], quantile: number): number => {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  if (quantile <= 0) {
    return sorted[0];
  }
  if (quantile >= 1) {
    return sorted[sorted.length - 1];
  }
  const rank = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const fraction = rank - lowerIndex;
  if (upperIndex === lowerIndex) {
    return sorted[lowerIndex];
  }
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  return lower + (upper - lower) * fraction;
};

const computeCausalQuantiles = (
  dtValues: readonly (number | null)[],
  options: NormalizedFeatureComputationOptions,
): {
  quantiles: Record<string, number | null>[];
  medians: Array<number | null>;
} => {
  const windowValues: number[] = [];
  const quantilesPerEvent: Record<string, number | null>[] = [];
  const medians: Array<number | null> = [];

  for (let index = 0; index < dtValues.length; index += 1) {
    const dt = dtValues[index];
    if (dt !== null) {
      windowValues.push(dt);
      if (windowValues.length > options.windowSize) {
        windowValues.splice(0, windowValues.length - options.windowSize);
      }
    }
    const windowSnapshot = windowValues.slice(-options.windowSize);
    if (windowSnapshot.length === 0) {
      const emptyQuantiles: Record<string, number | null> = {};
      for (const label of options.quantileLabels) {
        emptyQuantiles[label] = null;
      }
      quantilesPerEvent.push(emptyQuantiles);
      medians.push(null);
      continue;
    }
    const sorted = [...windowSnapshot].sort((a, b) => a - b);
    const quantileValues: Record<string, number | null> = {};
    for (let qIndex = 0; qIndex < options.quantiles.length; qIndex += 1) {
      const label = options.quantileLabels[qIndex];
      const quantileValue = computeQuantileFromSorted(sorted, options.quantiles[qIndex]);
      quantileValues[label] = Number.isFinite(quantileValue) ? quantileValue : null;
    }
    quantilesPerEvent.push(quantileValues);
    const median = computeQuantileFromSorted(sorted, 0.5);
    medians.push(Number.isFinite(median) ? median : null);
  }

  return { quantiles: quantilesPerEvent, medians };
};

const buildFeatureColumnOrder = (options: NormalizedFeatureComputationOptions): string[] => {
  return [
    ...BASE_FEATURE_COLUMNS.slice(0, 5),
    ...BASE_FEATURE_COLUMNS.slice(5, 7),
    ...options.quantileLabels,
    ...BASE_FEATURE_COLUMNS.slice(7),
  ];
};

const buildCsvHeader = (options: NormalizedFeatureComputationOptions): string => {
  const featureColumns = buildFeatureColumnOrder(options);
  return [...BASE_HEADER_COLUMNS, ...featureColumns, 'sid_final'].join(',');
};

export const augmentRows = <T extends SimulationEvent>(
  rows: readonly T[],
  extras: FeatureOverrides = {},
  featureOptionsInput?: FeatureComputationOptions | NormalizedFeatureComputationOptions,
): Array<T & AugmentedSimulationEvent> => {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const featureOptions = normalizeFeatureOptions(featureOptionsInput);

  const resolvers: Record<string, FeatureResolver | null> = { ...extrasResolvers };
  for (const label of featureOptions.quantileLabels) {
    if (!hasOwn.call(resolvers, label)) {
      resolvers[label] = null;
    }
  }

  for (const [column, resolver] of Object.entries(extras)) {
    if (resolver !== undefined && resolver !== null && typeof resolver !== 'function') {
      throw new TypeError(`${column} override must be a function when provided`);
    }
    if (resolver !== undefined) {
      resolvers[column] = resolver ?? null;
    }
  }

  const sanitizedRows = rows.map((event) =>
    event && typeof event === 'object' ? ({ ...event } as SimulationEvent) : ({}) as SimulationEvent,
  );

  const dtValues = sanitizedRows.map((event, index) => {
    const fallback = sanitizeNumeric(extractDeltaSeconds(event));
    const resolver = resolvers.dt_sec;
    const resolved = resolver
      ? sanitizeNumeric(resolver(event, index, sanitizedRows, fallback))
      : fallback;
    return resolved !== null && resolved > 0 ? resolved : null;
  });

  const positiveDtValues = dtValues.filter((value): value is number => value !== null);
  const { mean, std } = computeMeanAndStd(positiveDtValues);
  const { median: medianDt, scaledMad: madDt } = computeMedianAndMad(positiveDtValues);
  const hourlyStats = computeHourlyStats(sanitizedRows, dtValues);
  const { quantiles: windowQuantiles, medians: windowMedians } = computeCausalQuantiles(
    dtValues,
    featureOptions,
  );

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

    const clippedFallback = zScore === null
      ? null
      : clamp(zScore, featureOptions.clipBounds.min, featureOptions.clipBounds.max);
    const zClippedResolver = resolvers.z_clipped;
    const zClipped = zClippedResolver
      ? sanitizeNumeric(zClippedResolver(event, index, sanitizedRows, clippedFallback)) ?? clippedFallback
      : clippedFallback;

    let zRobust: number | null = null;
    if (dtSec !== null && medianDt !== null) {
      if (madDt && madDt > 0) {
        zRobust = (dtSec - medianDt) / madDt;
      } else {
        zRobust = 0;
      }
    }
    const zRobustResolver = resolvers.z_robust;
    if (zRobustResolver) {
      const override = zRobustResolver(event, index, sanitizedRows, zRobust);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        zRobust = numeric;
      }
    }

    let zHourly: number | null = null;
    if (dtSec !== null) {
      const timestampRaw = typeof event.timestamp === 'string'
        ? event.timestamp
        : (event as Record<string, unknown>).timestamp_utc;
      if (typeof timestampRaw === 'string') {
        const parsed = new Date(timestampRaw);
        if (!Number.isNaN(parsed.getTime())) {
          const hourStats = hourlyStats[parsed.getUTCHours()];
          if (hourStats && hourStats.median !== null) {
            if (hourStats.scaledMad && hourStats.scaledMad > 0) {
              zHourly = (dtSec - hourStats.median) / hourStats.scaledMad;
            } else {
              zHourly = 0;
            }
          }
        }
      }
    }
    const zHourlyResolver = resolvers.z_hourly;
    if (zHourlyResolver) {
      const override = zHourlyResolver(event, index, sanitizedRows, zHourly);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        zHourly = numeric;
      }
    }

    const labelFallback = dtSec === null ? 'unknown' : 'ok';
    const labelResolver = resolvers.time_label;
    const labelOverride = labelResolver
      ? labelResolver(event, index, sanitizedRows, labelFallback)
      : null;
    const timeLabel = labelOverride ? normalizeLabel(labelOverride) : normalizeLabel(labelFallback);

    const quantileFallbacks = windowQuantiles[index];
    const quantileValues: Record<string, number | null> = {};
    for (const label of featureOptions.quantileLabels) {
      const fallback = quantileFallbacks[label] ?? null;
      const resolver = resolvers[label];
      if (resolver) {
        const override = resolver(event, index, sanitizedRows, fallback);
        const numeric = sanitizeNumeric(override);
        quantileValues[label] = numeric !== null ? numeric : fallback;
      } else {
        quantileValues[label] = fallback;
      }
    }

    let logBurstDelta: number | null = null;
    const windowMedian = windowMedians[index];
    if (logDt !== null && windowMedian !== null && windowMedian > 0) {
      logBurstDelta = Math.log(Math.exp(logDt) / windowMedian);
    }
    const logBurstResolver = resolvers.log_burst_delta;
    if (logBurstResolver) {
      const override = logBurstResolver(event, index, sanitizedRows, logBurstDelta);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        logBurstDelta = numeric;
      }
    }

    let logBurstFlag: number | null = null;
    if (logBurstDelta !== null) {
      logBurstFlag = logBurstDelta > featureOptions.logBurstThreshold ? 1 : 0;
    }
    const logBurstFlagResolver = resolvers.log_burst_flag;
    if (logBurstFlagResolver) {
      const override = logBurstFlagResolver(event, index, sanitizedRows, logBurstFlag);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        logBurstFlag = numeric;
      }
    }

    return {
      ...(event as Record<string, unknown>),
      dt_sec: dtSec,
      log_dt: logDt,
      z: zScore,
      z_clipped: zClipped,
      time_label: timeLabel,
      z_robust: zRobust,
      z_hourly: zHourly,
      log_burst_delta: logBurstDelta,
      log_burst_flag: logBurstFlag,
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
  featureOptionsInput?: FeatureComputationOptions | NormalizedFeatureComputationOptions,
): string => {
  const safeEvent = event && typeof event === 'object' ? event : ({} as AugmentedSimulationEvent);
  const featureOptions = normalizeFeatureOptions(featureOptionsInput);
  const featureColumns = buildFeatureColumnOrder(featureOptions);
  const metadata = serializeMetadata(safeEvent.metadata);
  const sidFinal = resolveSidFinal(safeEvent);
  const safeRecord = safeEvent as Record<string, unknown>;
  const featureValues = featureColumns.map((column) => (
    column in safeRecord ? safeRecord[column] : null
  ));
  const row = [
    safeEvent.timestamp,
    safeEvent.session_id,
    safeEvent.user_id,
    safeEvent.event,
    safeEvent.method,
    safeEvent.path,
    safeEvent.status,
    safeEvent.latency_ms,
    extractDeltaSeconds(safeEvent),
    metadata,
    ...featureValues,
    sidFinal,
  ].map(toCsvField);
  return row.join(',');
};

const formatCsvRows = (
  events: readonly SimulationEvent[],
  extras?: FeatureOverrides,
  featureOptionsInput?: FeatureComputationOptions | NormalizedFeatureComputationOptions,
): string => {
  const featureOptions = normalizeFeatureOptions(featureOptionsInput);
  const augmented = augmentRows(events, extras ?? {}, featureOptions);
  const header = buildCsvHeader(featureOptions);
  const rows = [header];
  for (const event of augmented) {
    rows.push(formatCsvAugmented(event, featureOptions));
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
  feature_augmenter: overrides.feature_augmenter ?? {
    window_size: DEFAULT_NORMALIZED_FEATURE_OPTIONS.windowSize,
    clip_bounds: DEFAULT_NORMALIZED_FEATURE_OPTIONS.clipBounds,
    quantiles: DEFAULT_NORMALIZED_FEATURE_OPTIONS.quantiles,
    quantile_labels: DEFAULT_NORMALIZED_FEATURE_OPTIONS.quantileLabels,
    log_burst_threshold: DEFAULT_NORMALIZED_FEATURE_OPTIONS.logBurstThreshold,
  },
  feature_columns: overrides.feature_columns ?? buildFeatureColumnOrder(DEFAULT_NORMALIZED_FEATURE_OPTIONS),
});

export const persistSimulationRun = async (
  input: PersistSimulationInput,
): Promise<PersistSimulationResult> => {
  const events = Array.isArray(input?.events) ? (input.events as SimulationEvent[]) : [];
  if (events.length === 0) {
    throw new Error('persistSimulationRun requires a non-empty events array');
  }

  const labeled = labelSequence(events);
  const runId = sanitizeRunId(input?.runId) || generateRunId();
  const generatedAt = new Date().toISOString();
  const outputDir = input?.outputDir ? path.resolve(input.outputDir) : config.simLogRoot;

  await ensureDirectory(outputDir);

  const csvFileName = input?.csvFileName || `simEvents-${runId}.csv`;
  const manifestFileName = input?.manifestFileName || `scenario-${runId}.json`;
  const csvPath = path.join(outputDir, csvFileName);
  const manifestPath = path.join(outputDir, manifestFileName);

  const featureOptions = normalizeFeatureOptions(input?.featureOptions);
  const csvContent = formatCsvRows(labeled, input?.featureOverrides, featureOptions);
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
      feature_augmenter: {
        window_size: featureOptions.windowSize,
        clip_bounds: featureOptions.clipBounds,
        quantiles: featureOptions.quantiles,
        quantile_labels: featureOptions.quantileLabels,
        log_burst_threshold: featureOptions.logBurstThreshold,
      },
      feature_columns: buildFeatureColumnOrder(featureOptions),
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
  normalizeFeatureOptions,
};

export default simWriter;
