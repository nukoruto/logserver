import type { DeltaAnnotatedRow } from './delta.js';
import type { UserGroupedRow } from './grouping.js';

export interface SessionIdentifierContext<T extends UserGroupedRow> {
  uid: string;
  sessionSequence: number;
  sessionStartEpochSeconds: number;
  annotatedRow: DeltaAnnotatedRow<T>;
}

export interface AssignSessionsOptions<T extends UserGroupedRow> {
  makeSid: (context: SessionIdentifierContext<T>) => string;
}

export interface SessionAnnotatedRow<T extends UserGroupedRow> extends DeltaAnnotatedRow<T> {
  sessionId: string;
  sessionSequence: number;
  sessionIndex: number;
  sessionStartEpochSeconds: number;
}

function sanitizeThreshold(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    return 0;
  }
  return value;
}

function isFiniteTimestamp(row: UserGroupedRow): boolean {
  return typeof row.timestamp_epoch_seconds === 'number' && Number.isFinite(row.timestamp_epoch_seconds);
}

export function assignSessions<T extends UserGroupedRow>(
  userRows: readonly DeltaAnnotatedRow<T>[],
  deltaThreshold: number,
  options: AssignSessionsOptions<T>
): SessionAnnotatedRow<T>[] {
  if (!Array.isArray(userRows)) {
    throw new TypeError('userRows must be an array');
  }
  if (!options || typeof options.makeSid !== 'function') {
    throw new TypeError('options.makeSid must provide a makeSid function');
  }

  const threshold = sanitizeThreshold(deltaThreshold);
  const result: SessionAnnotatedRow<T>[] = [];

  let currentSequence = -1;
  let currentIndex = -1;
  let currentSessionId = '';
  let currentSessionStart = Number.NaN;

  for (const annotated of userRows) {
    if (!annotated || typeof annotated !== 'object') {
      throw new TypeError('Each entry must be a DeltaAnnotatedRow');
    }

    const { row, deltaSeconds, timeLabel } = annotated;
    if (!row || typeof row.uid !== 'string') {
      throw new TypeError('Each row must include a uid field');
    }
    if (!isFiniteTimestamp(row)) {
      throw new TypeError('Each row must include a finite timestamp_epoch_seconds field');
    }

    let startNewSession = false;
    if (currentSequence < 0) {
      startNewSession = true;
    } else if (timeLabel === 'initial') {
      startNewSession = true;
    } else if (
      timeLabel === 'measured' &&
      typeof deltaSeconds === 'number' &&
      Number.isFinite(deltaSeconds) &&
      deltaSeconds > threshold
    ) {
      startNewSession = true;
    }

    if (startNewSession) {
      currentSequence += 1;
      currentIndex = 0;
      currentSessionStart = row.timestamp_epoch_seconds;
      currentSessionId = options.makeSid({
        uid: row.uid,
        sessionSequence: currentSequence,
        sessionStartEpochSeconds: currentSessionStart,
        annotatedRow: annotated
      });

      if (typeof currentSessionId !== 'string' || currentSessionId.length === 0) {
        throw new TypeError('makeSid must return a non-empty string');
      }
    } else {
      currentIndex += 1;
    }

    result.push({
      ...annotated,
      sessionId: currentSessionId,
      sessionSequence: currentSequence,
      sessionIndex: currentIndex,
      sessionStartEpochSeconds: currentSessionStart
    });
  }

  return result;
}
