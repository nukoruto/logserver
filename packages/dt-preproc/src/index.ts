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

const ROBUST_SCALE_FACTOR = 1.4826;
const ROBUST_Z_FLOOR = 1e-12;

export type LogRow = CsvRow;

export interface LogRowWithFeats extends LogRow {
  delta_seconds: number | null;
  delta_clipped_seconds: number | null;
  delta_robust_z: number | null;
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
}

export interface NormalizedFeatureOptions extends FeatureOptions {}

export interface RobustStats {
  x_med: number;
  x_smad: number;
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
  robustZClip: 5
};

export const DEFAULT_OPTIONS: FeatureOptions = { ...DEFAULT_FEATURE_OPTIONS };

interface SessionState {
  sequence: number;
  startTime: number | null;
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

  return {
    epsilon,
    epsilonT,
    clipMaxSeconds,
    robustScaleEpsilon: robustScaleEpsilon > 0 ? robustScaleEpsilon : DEFAULT_FEATURE_OPTIONS.robustScaleEpsilon,
    robustZClip
  };
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

interface RobustSummary extends RobustStats {
  x_mad: number;
}

function computeRobustSummary(values: readonly number[]): RobustSummary | null {
  if (values.length === 0) {
    return null;
  }
  const median = computeMedian(values);
  const deviations = values.map((value) => Math.abs(value - median));
  const mad = computeMedian(deviations);
  const smad = ROBUST_SCALE_FACTOR * mad;
  return {
    x_med: median,
    x_mad: mad,
    x_smad: smad
  };
}

export function robustZ(x: number, stats: RobustStats): number {
  const smad = Math.max(stats.x_smad, ROBUST_Z_FLOOR);
  return (x - stats.x_med) / smad;
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

export function computeFeatureRows(
  rows: readonly LogRow[],
  options: Partial<FeatureOptions> = {}
): { rows: LogRowWithFeats[]; stats: FeatureStats; options: NormalizedFeatureOptions } {
  const normalized = normalizeFeatureOptions(options);

  const measuredValues: number[] = [];
  const measuredValuesByUser = new Map<string, number[]>();
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
          startTime: isFiniteNumber(baseRow.timestamp_epoch_seconds) ? baseRow.timestamp_epoch_seconds : null
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

      let clipped: number | null = null;
      if (deltaSeconds !== null) {
        const sanitized = Math.max(0, deltaSeconds);
        clipped = Math.min(sanitized, normalized.clipMaxSeconds);
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
      }

      if (timeLabel === 'measured') {
        stats.measured += 1;
      } else if (timeLabel === 'unknown') {
        stats.unknown += 1;
      } else {
        stats.initial += 1;
      }

      featureRows.push({
        ...baseRow,
        delta_seconds: deltaSeconds,
        delta_clipped_seconds: clipped,
        delta_robust_z: null,
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
    const fallbackStats: RobustStats | null = globalSummary
      ? {
          x_med: globalSummary.x_med,
          x_smad: Math.max(globalSummary.x_smad, normalized.robustScaleEpsilon)
        }
      : null;

    if (fallbackStats) {
      stats.deltaMedian = fallbackStats.x_med;
      stats.deltaMad = fallbackStats.x_smad / ROBUST_SCALE_FACTOR;
      stats.deltaRobustScale = fallbackStats.x_smad;
    }

    const perUserStats = new Map<string, RobustStats>();
    for (const [uid, values] of measuredValuesByUser.entries()) {
      const summary = computeRobustSummary(values);
      if (summary && summary.x_smad >= normalized.robustScaleEpsilon) {
        perUserStats.set(uid, { x_med: summary.x_med, x_smad: summary.x_smad });
      } else if (fallbackStats) {
        perUserStats.set(uid, fallbackStats);
      } else if (summary) {
        perUserStats.set(uid, {
          x_med: summary.x_med,
          x_smad: Math.max(summary.x_smad, normalized.robustScaleEpsilon)
        });
      }
    }

    for (const row of featureRows) {
      if (row.delta_clipped_seconds === null) {
        continue;
      }
      const statsForUser = perUserStats.get(row.uid) ?? fallbackStats;
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
