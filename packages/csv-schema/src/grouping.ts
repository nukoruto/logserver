export interface UserGroupedRow {
  uid: string;
  timestamp_epoch_seconds: number;
  timestamp_utc?: string;
  row_index?: number;
}

type DecoratedRow<T extends UserGroupedRow> = {
  row: T;
  epochSeconds: number;
  fractionMilliseconds: number;
  rowIndex: number | null;
  originalOrder: number;
};

type UserCallback<T extends UserGroupedRow> = (uid: string, rows: readonly T[]) => void;

const FRACTIONAL_PART = /(\.\d{1,9})/;

function normalizeFractionMilliseconds(row: UserGroupedRow): number {
  if (typeof row.timestamp_utc === 'string') {
    const match = row.timestamp_utc.match(FRACTIONAL_PART);
    if (match) {
      const digits = match[1].slice(1, 4).padEnd(3, '0');
      const parsed = Number.parseInt(digits, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  const integerPart = Math.trunc(row.timestamp_epoch_seconds);
  const fractional = row.timestamp_epoch_seconds - integerPart;
  if (!Number.isFinite(fractional) || fractional <= 0) {
    return 0;
  }
  return Math.round(fractional * 1000);
}

function decorateRow<T extends UserGroupedRow>(row: T, index: number): DecoratedRow<T> {
  const epochSeconds = Math.trunc(row.timestamp_epoch_seconds);
  const rowIndex =
    typeof row.row_index === 'number' && Number.isFinite(row.row_index)
      ? row.row_index
      : null;

  return {
    row,
    epochSeconds,
    fractionMilliseconds: normalizeFractionMilliseconds(row),
    rowIndex,
    originalOrder: index
  };
}

function compareDecoratedRows<T extends UserGroupedRow>(a: DecoratedRow<T>, b: DecoratedRow<T>): number {
  if (a.epochSeconds !== b.epochSeconds) {
    return a.epochSeconds - b.epochSeconds;
  }
  if (a.fractionMilliseconds !== b.fractionMilliseconds) {
    return a.fractionMilliseconds - b.fractionMilliseconds;
  }
  if (a.rowIndex !== b.rowIndex) {
    if (a.rowIndex === null) {
      return 1;
    }
    if (b.rowIndex === null) {
      return -1;
    }
    return a.rowIndex - b.rowIndex;
  }
  return a.originalOrder - b.originalOrder;
}

function strictlyIncreasing<T extends UserGroupedRow>(rows: DecoratedRow<T>[]): T[] {
  const ordered: T[] = [];
  let lastEpoch: number | null = null;
  let lastFraction: number | null = null;
  let lastRowIndex: number | null = null;

  for (const item of rows) {
    const { epochSeconds, fractionMilliseconds, rowIndex } = item;

    if (!Number.isFinite(epochSeconds)) {
      continue;
    }

    let keep = false;
    if (lastEpoch === null || epochSeconds > lastEpoch) {
      keep = true;
    } else if (epochSeconds === lastEpoch) {
      if (lastFraction === null || fractionMilliseconds > lastFraction) {
        keep = true;
      } else if (fractionMilliseconds === lastFraction) {
        if (rowIndex !== null && lastRowIndex !== null && rowIndex > lastRowIndex) {
          keep = true;
        } else {
          keep = false;
        }
      }
    }

    if (!keep) {
      continue;
    }

    ordered.push(item.row);
    lastEpoch = epochSeconds;
    lastFraction = fractionMilliseconds;
    lastRowIndex = rowIndex;
  }

  return ordered;
}

export function forEachUser<T extends UserGroupedRow>(rows: Iterable<T>, callback: UserCallback<T>): void {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    if (!row || typeof row.uid !== 'string') {
      throw new TypeError('Row must include a uid field');
    }
    if (typeof row.timestamp_epoch_seconds !== 'number' || Number.isNaN(row.timestamp_epoch_seconds)) {
      throw new TypeError('Row must include a valid timestamp_epoch_seconds field');
    }

    const list = grouped.get(row.uid);
    if (list) {
      list.push(row);
    } else {
      grouped.set(row.uid, [row]);
    }
  }

  for (const [uid, list] of grouped.entries()) {
    const decorated = list.map((row, index) => decorateRow(row, index));
    decorated.sort(compareDecoratedRows);
    const ordered = strictlyIncreasing(decorated);
    if (ordered.length > 0) {
      callback(uid, ordered);
    }
  }
}

export type { UserCallback };
