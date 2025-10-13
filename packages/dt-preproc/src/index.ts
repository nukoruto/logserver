import { Readable } from 'node:stream';
import {
  computeDeltas,
  forEachUser,
  parseCsv,
  type CsvParseStats,
  type CsvRow,
  type DeltaTimeLabel,
  type ParseCsvOptions
} from '@logserver/csv-schema';
import { lburst } from './math.js';

const ROBUST_SCALE_FACTOR = 1.4826;
const ROBUST_Z_FLOOR = 1e-12;
const LOG_EPS_FLOOR = 1e-12;

export type LogRow = CsvRow;

export interface RobustScaleStats {
  x_med: number;
  x_mad: number;
  x_smad: number;
}

export interface RobustStats extends RobustScaleStats {
  byHour: Record<number, RobustScaleStats>;
}

export type GroupKey = { uid: string; session_id?: string };

export interface PreprocCfg {
  epsilon: number;
  epsilon_t: number;
  grouping?: 'uid' | 'uid_session';
}

export interface FittedStats {
  epsilon: number;
  groups: Map<string, RobustStats>;
  global: RobustStats;
}

export interface FrozenRobustStats extends RobustStats {}

export interface FrozenFittedStats {
  epsilon: number;
  groups: Record<string, FrozenRobustStats>;
  global: FrozenRobustStats;
}

export interface LogRowWithFeats extends LogRow {
  delta_seconds: number | null;
  delta_clipped_seconds: number | null;
  delta_robust_z: number | null;
  delta_log_burst: number | null;
  delta_time_label: DeltaTimeLabel;
  session_sequence: number;
  session_elapsed_seconds: number | null;
  is_session_start: boolean;
}

export interface FeatureOptions {
  epsilon: number;
  epsilonT: number;
  clipMaxSeconds: number;
  robustScaleEpsilon: number;
  robustZClip: number;
  minSamples: number;
}

export interface NormalizedFeatureOptions extends FeatureOptions {}

export interface GroupKey {
  uid: string;
  [dimension: string]: string | null | undefined;
}

export interface FittedStats {
  global: RobustStats | null;
  groups: Map<string, RobustStats>;
}

function keyEntries(key: GroupKey): [string, string][] {
  const entries: [string, string][] = [];
  for (const [field, rawValue] of Object.entries(key)) {
    if (field === 'uid') {
      if (typeof rawValue === 'string' && rawValue.length > 0) {
        entries.push([field, rawValue]);
      }
      continue;
    }
    if (typeof rawValue !== 'string') {
      continue;
    }
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      continue;
    }
    entries.push([field, trimmed]);
  }

  entries.sort(([a], [b]) => {
    if (a === 'uid') {
      return b === 'uid' ? 0 : -1;
    }
    if (b === 'uid') {
      return 1;
    }
    return a.localeCompare(b);
  });

  return entries;
}

export function keyStr(key: GroupKey): string {
  const entries = keyEntries(key);
  if (entries.length === 0) {
    return '';
  }
  return entries
    .map(([field, value]) => `${encodeURIComponent(field)}=${encodeURIComponent(value)}`)
    .join('&');
}

export function chooseStats(key: GroupKey, fitted: FittedStats): RobustStats | null {
  const direct = fitted.groups.get(keyStr(key));
  if (direct) {
    return direct;
  }
  const perUser = fitted.groups.get(keyStr({ uid: key.uid }));
  if (perUser) {
    return perUser;
  }
  return fitted.global;
export interface StatsUpdateRecord {
  field: 'x_med' | 'x_smad';
  previous: number;
  next: number;
  delta: number;
}

export interface StatsMeta {
  updates: StatsUpdateRecord[];
  lastInput?: number;
  lastTrimmed?: number;
}

export interface RobustStats {
  x_med: number;
  x_smad: number;
  meta?: StatsMeta;
}

export interface UpdateCfg {
  alpha: number;
  trim: {
    low: number;
    high: number;
  };
  maxDrift: number;
}

export interface FeatureStats {
  total: number;
  measured: number;
  unknown: number;
  initial: number;
  clipped: number;
  filteredOut: number;
  deltaMedian: number | null;
  deltaMad: number | null;
  deltaRobustScale: number | null;
}

export interface PipelineResult {
  rows: LogRowWithFeats[];
  parseStats: CsvParseStats;
  featureStats: FeatureStats;
  options: NormalizedFeatureOptions;
}

export interface PipelineOptions extends Partial<FeatureOptions> {
  validateSchema?: boolean;
  expectedColumns?: readonly string[];
  filter?: (row: LogRow) => boolean;
  parseOptions?: ParseCsvOptions;
}

const DEFAULT_FEATURE_OPTIONS: FeatureOptions = {
  epsilon: 0.0005,
  epsilonT: 0.05,
  clipMaxSeconds: 300,
  robustScaleEpsilon: 1e-9,
  robustZClip: 5,
  minSamples: 8
};

export const DEFAULT_OPTIONS: FeatureOptions = { ...DEFAULT_FEATURE_OPTIONS };

interface SessionState {
  sequence: number;
  startTime: number | null;
  prevMeasuredDelta: number | null;
}

interface MutableFeatureStats extends FeatureStats {}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeFeatureOptions(options: Partial<FeatureOptions> = {}): NormalizedFeatureOptions {
  const epsilon = Math.max(0, options.epsilon ?? DEFAULT_FEATURE_OPTIONS.epsilon);
  const epsilonT = Math.max(0, options.epsilonT ?? DEFAULT_FEATURE_OPTIONS.epsilonT);
  const clipCandidate = options.clipMaxSeconds ?? DEFAULT_FEATURE_OPTIONS.clipMaxSeconds;
  const clipMaxSeconds = clipCandidate > 0 ? clipCandidate : DEFAULT_FEATURE_OPTIONS.clipMaxSeconds;
  const robustScaleEpsilon = options.robustScaleEpsilon ?? DEFAULT_FEATURE_OPTIONS.robustScaleEpsilon;
  const clipLimitCandidate = options.robustZClip ?? DEFAULT_FEATURE_OPTIONS.robustZClip;
  const robustZClip = clipLimitCandidate > 0 ? clipLimitCandidate : DEFAULT_FEATURE_OPTIONS.robustZClip;
  const minSamplesCandidate = options.minSamples ?? DEFAULT_FEATURE_OPTIONS.minSamples;
  const minSamples = Number.isFinite(minSamplesCandidate)
    ? Math.max(1, Math.floor(minSamplesCandidate))
    : DEFAULT_FEATURE_OPTIONS.minSamples;

  return {
    epsilon,
    epsilonT,
    clipMaxSeconds,
    robustScaleEpsilon: robustScaleEpsilon > 0 ? robustScaleEpsilon : DEFAULT_FEATURE_OPTIONS.robustScaleEpsilon,
    robustZClip,
    minSamples
  };
}

export function rollingQuantilesR7(
  past: readonly number[],
  qs: readonly number[] = [0.25, 0.5, 0.75]
): number[] {
  const finiteValues = past.filter((value) => isFiniteNumber(value));

  if (finiteValues.length === 0) {
    return qs.map(() => 0);
  }

  const sorted = [...finiteValues].sort((a, b) => a - b);
  const n = sorted.length;

  return qs.map((rawQ) => {
    const q = Number.isFinite(rawQ) ? Math.min(Math.max(rawQ, 0), 1) : 0.5;

    if (n === 1 || q === 0) {
      return sorted[0];
    }
    if (q === 1) {
      return sorted[n - 1];
    }

    const h = (n - 1) * q + 1;
    const lowerIndex = Math.floor(h) - 1;
    const upperIndex = Math.ceil(h) - 1;
    const fraction = h - Math.floor(h);

    if (lowerIndex === upperIndex) {
      return sorted[lowerIndex];
    }

    const lowerValue = sorted[Math.max(0, Math.min(lowerIndex, n - 1))];
    const upperValue = sorted[Math.max(0, Math.min(upperIndex, n - 1))];

    return lowerValue + fraction * (upperValue - lowerValue);
  });
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot compute median of empty array');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function computeRobustSummary(values: readonly number[]): RobustScaleStats | null {
  if (values.length === 0) {
    return null;
  }
  const median = computeMedian(values);
  const deviations = values.map((value) => Math.abs(value - median));
  const mad = computeMedian(deviations);
  const smad = ROBUST_SCALE_FACTOR * mad;
  return { x_med: median, x_mad: mad, x_smad: smad };
}

export function robustZ(x: number, stats: RobustScaleStats): number {
  const smad = Math.max(stats.x_smad, ROBUST_Z_FLOOR);
  return (x - stats.x_med) / smad;
}

function normalizeUpdateCfg(cfg: UpdateCfg): UpdateCfg {
  const alpha = Number.isFinite(cfg.alpha) ? Math.min(Math.max(cfg.alpha, 0), 1) : 0;
  const trimLow = Number.isFinite(cfg.trim?.low) ? Math.max(cfg.trim.low, 0) : 0;
  const trimHigh = Number.isFinite(cfg.trim?.high) ? Math.max(cfg.trim.high, 0) : 0;
  const maxDrift = Number.isFinite(cfg.maxDrift) && cfg.maxDrift > 0 ? cfg.maxDrift : 0;
  return {
    alpha,
    trim: {
      low: trimLow,
      high: trimHigh
    },
    maxDrift
  };
}

function clampValue(value: number, lower: number, upper: number): number {
  if (Number.isNaN(value)) {
    return Number.isFinite(lower) ? lower : value;
  }
  if (lower > upper) {
    return value;
  }
  return Math.min(Math.max(value, lower), upper);
}

function limitDrift(candidate: number, previous: number, scale: number, maxDrift: number): number {
  if (!Number.isFinite(candidate)) {
    return previous;
  }
  if (maxDrift <= 0) {
    return previous;
  }
  const baseScale = Math.max(Math.abs(previous), scale, ROBUST_Z_FLOOR);
  const maxShift = baseScale * maxDrift;
  const diff = candidate - previous;
  if (!Number.isFinite(diff)) {
    return previous;
  }
  if (Math.abs(diff) <= maxShift) {
    return candidate;
  }
  return previous + Math.sign(diff) * maxShift;
}

function appendMetaUpdates(
  prev: RobustStats,
  records: StatsUpdateRecord[],
  rawInput: number | undefined,
  trimmed: number | undefined
): StatsMeta {
  const updates = [...(prev.meta?.updates ?? [])];
  updates.push(...records.filter((record) => record.delta !== 0));
  return {
    updates,
    lastInput: rawInput ?? prev.meta?.lastInput,
    lastTrimmed: trimmed ?? prev.meta?.lastTrimmed
  };
}

export function updateStatsStreaming(x: number, prev: RobustStats, cfg: UpdateCfg): RobustStats {
  if (!Number.isFinite(x)) {
    return {
      ...prev,
      meta: appendMetaUpdates(prev, [], undefined, undefined)
    };
  }

  const normalizedCfg = normalizeUpdateCfg(cfg);
  if (normalizedCfg.alpha === 0) {
    return {
      ...prev,
      meta: appendMetaUpdates(prev, [], x, x)
    };
  }

  const prevMed = prev.x_med;
  const prevSmad = Math.max(prev.x_smad, ROBUST_Z_FLOOR);
  const lowerBound = prevMed - normalizedCfg.trim.low * prevSmad;
  const upperBound = prevMed + normalizedCfg.trim.high * prevSmad;
  const trimmed = clampValue(x, lowerBound, upperBound);

  const emaMed = (1 - normalizedCfg.alpha) * prevMed + normalizedCfg.alpha * trimmed;
  const updatedMed = limitDrift(emaMed, prevMed, prevSmad, normalizedCfg.maxDrift);

  const deviation = Math.abs(trimmed - updatedMed);
  const emaSmad = (1 - normalizedCfg.alpha) * prevSmad + normalizedCfg.alpha * Math.max(deviation, ROBUST_Z_FLOOR);
  const updatedSmad = Math.max(
    ROBUST_Z_FLOOR,
    limitDrift(emaSmad, prevSmad, prevSmad, normalizedCfg.maxDrift)
  );

  const records: StatsUpdateRecord[] = [
    {
      field: 'x_med',
      previous: prevMed,
      next: updatedMed,
      delta: updatedMed - prevMed
    },
    {
      field: 'x_smad',
      previous: prevSmad,
      next: updatedSmad,
      delta: updatedSmad - prevSmad
    }
  ];

  return {
    x_med: updatedMed,
    x_smad: updatedSmad,
    meta: appendMetaUpdates(prev, records, x, trimmed)
  };
}

export function clip(value: number, limit = 5): number {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 5;
  if (!Number.isFinite(value)) {
    return value;
  }
  if (!Number.isFinite(safeLimit) || safeLimit === Infinity) {
    return value;
  }
  return Math.max(-safeLimit, Math.min(safeLimit, value));
}

function computeSessionElapsed(state: SessionState, timestamp: number | null): number | null {
  if (!isFiniteNumber(timestamp)) {
    return null;
  }
  if (!isFiniteNumber(state.startTime)) {
    state.startTime = timestamp;
    return 0;
  }
  const elapsed = timestamp - state.startTime;
  return elapsed >= 0 ? elapsed : 0;
}

function sanitizeDelta(deltaSeconds: number | null): number | null {
  if (deltaSeconds === null) {
    return null;
  }
  if (!Number.isFinite(deltaSeconds)) {
    return null;
  }
  if (deltaSeconds <= 0) {
    return 0;
  }
  return deltaSeconds;
}

export function computeFeatureRows(
  rows: readonly LogRow[],
  options: Partial<FeatureOptions> = {}
): { rows: LogRowWithFeats[]; stats: FeatureStats; options: NormalizedFeatureOptions } {
  const normalized = normalizeFeatureOptions(options);

  const measuredValues: number[] = [];
  const measuredValuesByUser = new Map<string, number[]>();
  const measuredValuesByGroup = new Map<string, number[]>();
  const featureRows: LogRowWithFeats[] = [];
  const stats: MutableFeatureStats = {
    total: 0,
    measured: 0,
    unknown: 0,
    initial: 0,
    clipped: 0,
    filteredOut: 0,
    deltaMedian: null,
    deltaMad: null,
    deltaRobustScale: null
  };

  forEachUser(rows, (_uid, userRows) => {
    const deltaResult = computeDeltas(userRows, {
      epsilon: normalized.epsilon,
      epsilon_t: normalized.epsilonT
    });

    const sessionState = new Map<string, SessionState>();

    for (const { row, deltaSeconds, timeLabel } of deltaResult.rows) {
      const baseRow = row;
      const sessionId = baseRow.session_id;
      let state = sessionState.get(sessionId);
      if (!state) {
        state = {
          sequence: 0,
          startTime: isFiniteNumber(baseRow.timestamp_epoch_seconds) ? baseRow.timestamp_epoch_seconds : null,
          prevMeasuredDelta: null
        };
        sessionState.set(sessionId, state);
      } else if (state.startTime === null && isFiniteNumber(baseRow.timestamp_epoch_seconds)) {
        state.startTime = baseRow.timestamp_epoch_seconds;
      }

      const sequence = state.sequence;
      state.sequence += 1;

      const elapsed = computeSessionElapsed(
        state,
        isFiniteNumber(baseRow.timestamp_epoch_seconds) ? baseRow.timestamp_epoch_seconds : null
      );

      const sanitized = sanitizeDelta(deltaSeconds);

      let clipped: number | null = null;
      if (sanitized !== null) {
        const bounded = Math.min(sanitized, normalized.clipMaxSeconds);
        clipped = bounded;
        if (sanitized > normalized.clipMaxSeconds) {
          stats.clipped += 1;
        }
        measuredValues.push(clipped);
        const perUser = measuredValuesByUser.get(baseRow.uid);
        if (perUser) {
          perUser.push(clipped);
        } else {
          measuredValuesByUser.set(baseRow.uid, [clipped]);
        }
        const groupKey = keyStr({ uid: baseRow.uid, session_id: baseRow.session_id });
        const perGroup = measuredValuesByGroup.get(groupKey);
        if (perGroup) {
          perGroup.push(clipped);
        } else {
          measuredValuesByGroup.set(groupKey, [clipped]);
        }
      }

      if (timeLabel === 'measured') {
        stats.measured += 1;
      } else if (timeLabel === 'unknown') {
        stats.unknown += 1;
      } else {
        stats.initial += 1;
      }

      let logBurst: number | null = null;
      if (timeLabel === 'measured' && sanitized !== null) {
        if (state.prevMeasuredDelta !== null && sequence > 0) {
          logBurst = lburst(state.prevMeasuredDelta, sanitized, normalized.epsilon);
        }
        state.prevMeasuredDelta = sequence > 0 ? sanitized : null;
      } else {
        state.prevMeasuredDelta = null;
      }

      featureRows.push({
        ...baseRow,
        delta_seconds: deltaSeconds,
        delta_clipped_seconds: clipped,
        delta_robust_z: null,
        delta_log_burst: logBurst,
        delta_time_label: timeLabel,
        session_sequence: sequence,
        session_elapsed_seconds: elapsed,
        is_session_start: sequence === 0
      });
    }
  });

  stats.total = featureRows.length;

  if (measuredValues.length > 0) {
    const globalSummary = computeRobustSummary(measuredValues);
    const fallbackStats: RobustScaleStats | null = globalSummary
      ? {
          x_med: globalSummary.x_med,
          x_mad: globalSummary.x_mad,
          x_smad: Math.max(globalSummary.x_smad, normalized.robustScaleEpsilon)
        }
      : null;

    if (fallbackStats) {
      stats.deltaMedian = fallbackStats.x_med;
      stats.deltaMad = fallbackStats.x_mad;
      stats.deltaRobustScale = fallbackStats.x_smad;
    }

    const fittedGroups = new Map<string, RobustStats>();
    const minSamples = normalized.minSamples;

    const perUserStats = new Map<string, RobustScaleStats>();
    for (const [uid, values] of measuredValuesByUser.entries()) {
      if (values.length < minSamples) {
        continue;
      }
      const summary = computeRobustSummary(values);
      if (summary && summary.x_smad >= normalized.robustScaleEpsilon) {
        fittedGroups.set(keyStr({ uid }), { x_med: summary.x_med, x_smad: summary.x_smad });
      } else if (fallbackStats) {
        fittedGroups.set(keyStr({ uid }), fallbackStats);
      } else if (summary) {
        fittedGroups.set(keyStr({ uid }), {
          x_med: summary.x_med,
          x_smad: Math.max(summary.x_smad, normalized.robustScaleEpsilon)
        });
      }
    }

    for (const [groupKey, values] of measuredValuesByGroup.entries()) {
      if (values.length < minSamples) {
        continue;
      }
      const summary = computeRobustSummary(values);
      if (summary && summary.x_smad >= normalized.robustScaleEpsilon) {
        fittedGroups.set(groupKey, { x_med: summary.x_med, x_smad: summary.x_smad });
        perUserStats.set(uid, {
          x_med: summary.x_med,
          x_mad: summary.x_mad,
          x_smad: summary.x_smad
        });
      } else if (fallbackStats) {
        fittedGroups.set(groupKey, fallbackStats);
      } else if (summary) {
        fittedGroups.set(groupKey, {
          x_med: summary.x_med,
          x_mad: summary.x_mad,
          x_smad: Math.max(summary.x_smad, normalized.robustScaleEpsilon)
        });
      }
    }

    const fitted: FittedStats = { global: fallbackStats, groups: fittedGroups };

    for (const row of featureRows) {
      if (row.delta_clipped_seconds === null) {
        continue;
      }
      const statsForUser = chooseStats({ uid: row.uid, session_id: row.session_id }, fitted);
      if (!statsForUser) {
        continue;
      }
      const z = robustZ(row.delta_clipped_seconds, statsForUser);
      row.delta_robust_z = clip(z, normalized.robustZClip);
    }
  }

  return { rows: featureRows, stats, options: normalized };
}

export async function loadLogRowsWithFeatures(
  source: string | Readable,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const parseOptions: ParseCsvOptions = {
    validateSchema: options.validateSchema !== false,
    expectedColumns: options.expectedColumns,
    ...options.parseOptions
  };

  const parser = parseCsv(source, parseOptions);
  const collected: LogRow[] = [];

  for await (const row of parser) {
    if (options.filter && !options.filter(row)) {
      continue;
    }
    collected.push(row);
  }

  const parseStats = parser.getStats();
  const { rows, stats, options: normalized } = computeFeatureRows(collected, options);
  stats.filteredOut = Math.max(0, parseStats.validRows - rows.length);

  return {
    rows,
    parseStats,
    featureStats: stats,
    options: normalized
  };
}

export { DEFAULT_FEATURE_OPTIONS };
export { lburst } from './math.js';

function normalizeGrouping(grouping?: 'uid' | 'uid_session'): 'uid' | 'uid_session' {
  if (grouping === 'uid_session') {
    return 'uid_session';
  }
  return 'uid';
}

function serializeGroupKey(key: GroupKey): string {
  if (key.session_id !== undefined) {
    return JSON.stringify({ uid: key.uid, session_id: key.session_id });
  }
  return JSON.stringify({ uid: key.uid });
}

function extractHour(row: LogRow): number | null {
  if (Number.isFinite(row.timestamp_epoch_seconds)) {
    const epochMs = Number(row.timestamp_epoch_seconds) * 1000;
    const date = new Date(epochMs);
    if (!Number.isNaN(date.getTime())) {
      return date.getUTCHours();
    }
  }
  if (typeof row.timestamp_utc === 'string') {
    const date = new Date(row.timestamp_utc);
    if (!Number.isNaN(date.getTime())) {
      return date.getUTCHours();
    }
  }
  return null;
}

function appendHourly(map: Map<number, number[]>, hour: number | null, value: number): void {
  if (!Number.isInteger(hour) || hour === null) {
    return;
  }
  const normalizedHour = ((hour % 24) + 24) % 24;
  const bucket = map.get(normalizedHour);
  if (bucket) {
    bucket.push(value);
  } else {
    map.set(normalizedHour, [value]);
  }
}

function buildHourlyStats(
  hourlyValues: Map<number, number[]>,
  defaultStats: RobustScaleStats,
  fallbackByHour?: Record<number, RobustScaleStats>
): Record<number, RobustScaleStats> {
  const record: Record<number, RobustScaleStats> = {};
  for (let hour = 0; hour < 24; hour += 1) {
    const values = hourlyValues.get(hour);
    if (values && values.length > 0) {
      const summary = computeRobustSummary(values);
      if (summary) {
        record[hour] = { ...summary };
        continue;
      }
    }
    if (fallbackByHour && fallbackByHour[hour]) {
      record[hour] = { ...fallbackByHour[hour] };
    } else {
      record[hour] = { ...defaultStats };
    }
  }
  return record;
}

function sanitizeRobustScaleStats(
  stats: RobustScaleStats | null | undefined,
  fallback?: RobustScaleStats
): RobustScaleStats {
  const baseFallback = fallback ?? { x_med: 0, x_mad: 0, x_smad: ROBUST_Z_FLOOR };
  const median = Number.isFinite(stats?.x_med) ? (stats!.x_med as number) : baseFallback.x_med;
  const madCandidate = Number.isFinite(stats?.x_mad) && (stats!.x_mad as number) >= 0 ? (stats!.x_mad as number) : baseFallback.x_mad;
  const smadCandidate = Number.isFinite(stats?.x_smad) && (stats!.x_smad as number) >= 0 ? (stats!.x_smad as number) : baseFallback.x_smad;
  const mad = madCandidate >= 0 ? madCandidate : 0;
  const smad = Math.max(smadCandidate, ROBUST_Z_FLOOR);
  return { x_med: median, x_mad: mad, x_smad: smad };
}

function cloneHourlyRecord(
  byHour: Record<number, RobustScaleStats> | undefined,
  fallback: RobustScaleStats
): Record<number, RobustScaleStats> {
  const normalizedFallback = sanitizeRobustScaleStats(fallback);
  const record: Record<number, RobustScaleStats> = {};
  const source = byHour as Record<number | string, RobustScaleStats> | undefined;
  for (let hour = 0; hour < 24; hour += 1) {
    const entry = source ? source[hour] ?? source[String(hour)] : undefined;
    record[hour] = sanitizeRobustScaleStats(entry, normalizedFallback);
  }
  return record;
}

function normalizeRobustStatsInput(stats: RobustStats | FrozenRobustStats | undefined): RobustStats {
  const base = sanitizeRobustScaleStats(stats ?? null);
  const byHour = cloneHourlyRecord(stats?.byHour, base);
  return {
    x_med: base.x_med,
    x_mad: base.x_mad,
    x_smad: base.x_smad,
    byHour
  };
}

export function freezeFittedStats(stats: FittedStats): FrozenFittedStats {
  if (!stats || typeof stats !== 'object') {
    throw new TypeError('stats must be a FittedStats object');
  }
  const epsilon = Number.isFinite(stats.epsilon) && stats.epsilon >= 0 ? stats.epsilon : LOG_EPS_FLOOR;
  const frozenGlobal: FrozenRobustStats = { ...normalizeRobustStatsInput(stats.global) };
  const frozenGroups: Record<string, FrozenRobustStats> = {};
  for (const [key, value] of stats.groups.entries()) {
    frozenGroups[key] = { ...normalizeRobustStatsInput(value) };
  }
  return {
    epsilon: Math.max(epsilon, LOG_EPS_FLOOR),
    global: frozenGlobal,
    groups: frozenGroups
  };
}

export function thawFittedStats(frozen: FrozenFittedStats): FittedStats {
  if (!frozen || typeof frozen !== 'object') {
    throw new TypeError('frozen stats must be an object');
  }
  const epsilonCandidate = Number.isFinite(frozen.epsilon) && frozen.epsilon >= 0 ? frozen.epsilon : LOG_EPS_FLOOR;
  const global = normalizeRobustStatsInput(frozen.global);
  const groups = new Map<string, RobustStats>();
  if (frozen.groups && typeof frozen.groups === 'object') {
    for (const key of Object.keys(frozen.groups)) {
      groups.set(key, normalizeRobustStatsInput(frozen.groups[key]));
    }
  }
  return {
    epsilon: Math.max(epsilonCandidate, LOG_EPS_FLOOR),
    global,
    groups
  };
}

export function fitRobustStats(rows: LogRow[], cfg: PreprocCfg): FittedStats {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }
  const epsilon = Number.isFinite(cfg?.epsilon) && cfg.epsilon >= 0 ? cfg.epsilon : 0;
  const epsilonT = Number.isFinite(cfg?.epsilon_t) && cfg.epsilon_t >= 0 ? cfg.epsilon_t : 0;
  const grouping = normalizeGrouping(cfg?.grouping);
  const logEps = Math.max(epsilon, LOG_EPS_FLOOR);

  const globalValues: number[] = [];
  const globalHourly = new Map<number, number[]>();
  const perGroup = new Map<
    string,
    { key: GroupKey; values: number[]; hourly: Map<number, number[]> }
  >();

  forEachUser(rows, (uid, userRows) => {
    const deltaResult = computeDeltas(userRows, { epsilon, epsilon_t: epsilonT });
    for (const { row, deltaSeconds, timeLabel } of deltaResult.rows) {
      if (timeLabel !== 'measured' || deltaSeconds === null) {
        continue;
      }
      if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
        continue;
      }
      const x = Math.log(deltaSeconds + logEps);
      if (!Number.isFinite(x)) {
        continue;
      }
      const hour = extractHour(row);
      globalValues.push(x);
      appendHourly(globalHourly, hour, x);

      const groupKey: GroupKey = grouping === 'uid_session'
        ? row.session_id !== undefined
          ? { uid, session_id: row.session_id }
          : { uid }
        : { uid };
      const serialized = serializeGroupKey(groupKey);
      let acc = perGroup.get(serialized);
      if (!acc) {
        acc = { key: groupKey, values: [], hourly: new Map<number, number[]>() };
        perGroup.set(serialized, acc);
      }
      acc.values.push(x);
      appendHourly(acc.hourly, hour, x);
    }
  });

  if (globalValues.length === 0) {
    throw new Error('No measured Δt values available to fit robust statistics');
  }

  const globalSummary = computeRobustSummary(globalValues);
  if (!globalSummary) {
    throw new Error('Failed to compute global robust statistics');
  }

  const globalStats: RobustStats = {
    x_med: globalSummary.x_med,
    x_mad: globalSummary.x_mad,
    x_smad: globalSummary.x_smad,
    byHour: buildHourlyStats(globalHourly, globalSummary)
  };

  const groupStats = new Map<string, RobustStats>();
  for (const [serialized, acc] of perGroup.entries()) {
    const summary = computeRobustSummary(acc.values);
    const baseStats: RobustScaleStats = summary
      ? summary
      : { x_med: globalStats.x_med, x_mad: globalStats.x_mad, x_smad: globalStats.x_smad };
    const hourly = buildHourlyStats(acc.hourly, baseStats, globalStats.byHour);
    groupStats.set(serialized, {
      x_med: baseStats.x_med,
      x_mad: baseStats.x_mad,
      x_smad: baseStats.x_smad,
      byHour: hourly
    });
  }

  return {
    epsilon: logEps,
    groups: groupStats,
    global: globalStats
  };
}
