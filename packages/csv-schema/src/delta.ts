import type { UserGroupedRow } from './grouping.js';

export type DeltaTimeLabel = 'initial' | 'measured' | 'unknown';

export interface DeltaAnnotatedRow<T extends UserGroupedRow> {
  row: T;
  deltaSeconds: number | null;
  timeLabel: DeltaTimeLabel;
}

export interface DeltaComputationStats {
  total: number;
  measured: number;
  unknown: number;
  initial: number;
}

export interface DeltaComputationOptions {
  /**
   * Half of the recording resolution in seconds (e.g. 0.0005 for 1 ms logs).
   */
  epsilon: number;
  /**
   * Upper bound of timing uncertainty in seconds (ntp_p95_ms + ingress_jitter_ms converted to seconds).
   */
  epsilon_t: number;
}

export interface DeltaComputationResult<T extends UserGroupedRow> {
  rows: DeltaAnnotatedRow<T>[];
  stats: DeltaComputationStats;
}

const INITIAL_STATS: DeltaComputationStats = {
  total: 0,
  measured: 0,
  unknown: 0,
  initial: 0
};

const EPSILON_MIN = 1e-6;

function sanitizeEpsilon(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return EPSILON_MIN;
  }
  return Math.max(value, EPSILON_MIN);
}

function sanitizeEpsilonT(value: number, epsilon: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    return epsilon;
  }
  return Math.max(value, epsilon);
}

function isFiniteTimestamp(row: UserGroupedRow): boolean {
  return Number.isFinite(row.timestamp_epoch_seconds);
}

export function computeDeltas<T extends UserGroupedRow>(
  userRows: readonly T[],
  options: DeltaComputationOptions
): DeltaComputationResult<T> {
  if (!Array.isArray(userRows)) {
    throw new TypeError('userRows must be an array');
  }

  const epsilon = sanitizeEpsilon(options.epsilon);
  const epsilonT = sanitizeEpsilonT(options.epsilon_t, epsilon);

  const annotated: DeltaAnnotatedRow<T>[] = [];
  const stats: DeltaComputationStats = { ...INITIAL_STATS, total: userRows.length };

  let previousRow: T | null = null;

  for (const row of userRows) {
    if (!isFiniteTimestamp(row)) {
      annotated.push({ row, deltaSeconds: null, timeLabel: 'initial' });
      stats.initial += 1;
      previousRow = row;
      continue;
    }

    if (previousRow === null || !isFiniteTimestamp(previousRow)) {
      annotated.push({ row, deltaSeconds: null, timeLabel: 'initial' });
      stats.initial += 1;
      previousRow = row;
      continue;
    }

    const currentTime = row.timestamp_epoch_seconds;
    const previousTime = previousRow.timestamp_epoch_seconds;
    let delta = currentTime - previousTime;

    if (!Number.isFinite(delta) || delta < 0) {
      annotated.push({ row, deltaSeconds: null, timeLabel: 'initial' });
      stats.initial += 1;
      previousRow = row;
      continue;
    }

    delta = Math.max(delta, epsilon);

    const timeLabel: DeltaTimeLabel = delta <= epsilonT ? 'unknown' : 'measured';
    annotated.push({ row, deltaSeconds: delta, timeLabel });

    if (timeLabel === 'unknown') {
      stats.unknown += 1;
    } else {
      stats.measured += 1;
    }

    previousRow = row;
  }

  return { rows: annotated, stats };
}
