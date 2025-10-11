import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachUser } from '../src/index.js';

interface TestRow {
  uid: string;
  timestamp_epoch_seconds: number;
  timestamp_utc: string;
  row_index?: number;
  id: string;
}

function toKey(row: TestRow): [number, number, number | null] {
  const epoch = Math.trunc(row.timestamp_epoch_seconds);
  const fraction = Math.round((row.timestamp_epoch_seconds - epoch) * 1000);
  const rowIndex =
    typeof row.row_index === 'number' && Number.isFinite(row.row_index)
      ? row.row_index
      : null;
  return [epoch, fraction, rowIndex];
}

function assertStrictlyIncreasing(rows: readonly TestRow[]): void {
  for (let i = 1; i < rows.length; i += 1) {
    const prev = toKey(rows[i - 1]);
    const curr = toKey(rows[i]);
    const greater =
      curr[0] > prev[0] ||
      (curr[0] === prev[0] && curr[1] > prev[1]) ||
      (curr[0] === prev[0] &&
        curr[1] === prev[1] &&
        curr[2] !== null &&
        prev[2] !== null &&
        curr[2] > prev[2]);
    assert.equal(
      greater,
      true,
      `rows must be strictly increasing at position ${i}: prev=${prev} curr=${curr}`
    );
  }
}

test('forEachUser groups rows by uid and sorts with stable keys', () => {
  const rows: TestRow[] = [
    {
      uid: 'user-1',
      timestamp_epoch_seconds: 1722528896.456,
      timestamp_utc: '2024-08-01T12:34:56.456Z',
      row_index: 2,
      id: 'later'
    },
    {
      uid: 'user-2',
      timestamp_epoch_seconds: 1722528895.01,
      timestamp_utc: '2024-08-01T12:34:55.010Z',
      row_index: 0,
      id: 'other-user'
    },
    {
      uid: 'user-1',
      timestamp_epoch_seconds: 1722528895.5,
      timestamp_utc: '2024-08-01T12:34:55.500Z',
      row_index: 1,
      id: 'middle'
    },
    {
      uid: 'user-1',
      timestamp_epoch_seconds: 1722528895.001,
      timestamp_utc: '2024-08-01T12:34:55.001Z',
      row_index: 0,
      id: 'first'
    }
  ];

  const grouped = new Map<string, readonly TestRow[]>();
  forEachUser(rows, (uid, userRows) => {
    grouped.set(uid, userRows);
    assertStrictlyIncreasing(userRows);
  });

  assert.deepEqual(grouped.get('user-1')?.map((row) => row.id), ['first', 'middle', 'later']);
  assert.deepEqual(grouped.get('user-2')?.map((row) => row.id), ['other-user']);
});

test('forEachUser resolves identical timestamps using row_index as tie-breaker', () => {
  const rows: TestRow[] = [
    {
      uid: 'user-3',
      timestamp_epoch_seconds: 1722528896,
      timestamp_utc: '2024-08-01T12:34:56.000Z',
      row_index: 2,
      id: 'second'
    },
    {
      uid: 'user-3',
      timestamp_epoch_seconds: 1722528896,
      timestamp_utc: '2024-08-01T12:34:56.000Z',
      row_index: 1,
      id: 'first'
    },
    {
      uid: 'user-3',
      timestamp_epoch_seconds: 1722528896,
      timestamp_utc: '2024-08-01T12:34:56.000Z',
      row_index: 3,
      id: 'third'
    }
  ];

  const collected: TestRow[][] = [];
  forEachUser(rows, (_uid, userRows) => {
    collected.push([...userRows]);
    assertStrictlyIncreasing(userRows);
  });

  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0].map((row) => row.id), ['first', 'second', 'third']);
});

test('forEachUser discards later duplicates without row_index information', () => {
  const rows: TestRow[] = [
    {
      uid: 'user-4',
      timestamp_epoch_seconds: 1722528897,
      timestamp_utc: '2024-08-01T12:34:57.000Z',
      id: 'missing-1'
    },
    {
      uid: 'user-4',
      timestamp_epoch_seconds: 1722528897,
      timestamp_utc: '2024-08-01T12:34:57.000Z',
      id: 'missing-2'
    },
    {
      uid: 'user-4',
      timestamp_epoch_seconds: 1722528897,
      timestamp_utc: '2024-08-01T12:34:57.000Z',
      row_index: 5,
      id: 'with-index'
    },
    {
      uid: 'user-4',
      timestamp_epoch_seconds: 1722528898,
      timestamp_utc: '2024-08-01T12:34:58.000Z',
      id: 'next-second'
    }
  ];

  const remaining: TestRow[][] = [];
  forEachUser(rows, (_uid, userRows) => {
    remaining.push([...userRows]);
    assertStrictlyIncreasing(userRows);
  });

  assert.deepEqual(remaining[0].map((row) => row.id), ['with-index', 'next-second']);
});
