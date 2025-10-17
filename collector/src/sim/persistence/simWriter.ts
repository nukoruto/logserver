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
  time_label: string | null;
};

export interface AugmentComputationOptions {
  epsilonT?: number;
  measurementEpsilon?: number;
}

const EPSILON_MIN = 1e-6;
const EPSILON_MAX = 1e-2;
const GLOBAL_SESSION_KEY = '__global__';

const CSV_HEADER =
  'timestamp,timestamp_utc,session_id,user_id,event,method,path,status,latency_ms,delta_t,metadata,dt_sec,log_dt,z,z_clipped,time_label,sid_final';

const EXTRA_COLUMN_NAMES = ['dt_sec', 'log_dt', 'z', 'z_clipped', 'time_label'] as const;

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

const extrasResolvers: Record<(typeof EXTRA_COLUMN_NAMES)[number], FeatureResolver | null> = {
  dt_sec: null,
  log_dt: null,
  z: null,
  z_clipped: null,
  time_label: null,
};

export const augmentRows = <T extends SimulationEvent>(
  rows: readonly T[],
  extras: FeatureOverrides = {},
  options: AugmentComputationOptions = {},
): Array<T & AugmentedSimulationEvent> => {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const resolvers: Record<string, FeatureResolver | null> = { ...extrasResolvers };
  for (const column of EXTRA_COLUMN_NAMES) {
    const resolver = extras[column];
    if (resolver !== undefined && typeof resolver !== 'function') {
      throw new TypeError(`${column} override must be a function when provided`);
    }
    resolvers[column] = resolver ?? null;
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

    let dtSec: number | null = resolvedDelta !== null && resolvedDelta > 0 ? resolvedDelta : null;
    let label: 'initial' | 'measured' | 'unknown';

    if (!timestamp) {
      label = 'unknown';
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
        label = 'unknown';
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
  }

  const positiveDtValues = dtValues.filter((value): value is number => value !== null);
  const { mean, std } = computeMeanAndStd(positiveDtValues);

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

    const clippedFallback = zScore === null ? null : clamp(zScore, -5, 5);
    const zClippedResolver = resolvers.z_clipped;
    const zClipped = zClippedResolver
      ? sanitizeNumeric(zClippedResolver(event, index, sanitizedRows, clippedFallback)) ?? clippedFallback
      : clippedFallback;

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
      time_label: timeLabel,
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

export const formatCsvAugmented = (event: AugmentedSimulationEvent): string => {
  const safeEvent = event && typeof event === 'object' ? event : ({} as AugmentedSimulationEvent);
  const metadata = serializeMetadata(safeEvent.metadata);
  const sidFinal = resolveSidFinal(safeEvent);
  const row = [
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
    safeEvent.dt_sec,
    safeEvent.log_dt,
    safeEvent.z,
    safeEvent.z_clipped,
    safeEvent.time_label,
    sidFinal,
  ].map(toCsvField);
  return row.join(',');
};

const formatCsvRows = (
  events: readonly SimulationEvent[],
  extras?: FeatureOverrides,
  options?: AugmentComputationOptions,
): string => {
  const augmented = augmentRows(events, extras ?? {}, options ?? {});
  const rows = [CSV_HEADER];
  for (const event of augmented) {
    rows.push(formatCsvAugmented(event));
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

  await ensureDirectory(outputDir);

  const csvFileName = input?.csvFileName || `simEvents-${runId}.csv`;
  const manifestFileName = input?.manifestFileName || `scenario-${runId}.json`;
  const csvPath = path.join(outputDir, csvFileName);
  const manifestPath = path.join(outputDir, manifestFileName);

  const csvContent = formatCsvRows(labeled, input?.featureOverrides, {
    epsilonT,
    measurementEpsilon,
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
