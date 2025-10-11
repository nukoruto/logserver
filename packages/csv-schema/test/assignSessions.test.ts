import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignSessions,
  type DeltaAnnotatedRow,
  type SessionAnnotatedRow
} from '../src/index.js';

interface TestRow {
  uid: string;
  timestamp_epoch_seconds: number;
  row_index: number;
}

test('assignSessions splits only when measured delta exceeds threshold', () => {
  const userRows: DeltaAnnotatedRow<TestRow>[] = [
    {
      row: { uid: 'user-1', timestamp_epoch_seconds: 1000, row_index: 0 },
      deltaSeconds: null,
      timeLabel: 'initial'
    },
    {
      row: { uid: 'user-1', timestamp_epoch_seconds: 1005, row_index: 1 },
      deltaSeconds: 5,
      timeLabel: 'measured'
    },
    {
      row: { uid: 'user-1', timestamp_epoch_seconds: 1021, row_index: 2 },
      deltaSeconds: 16,
      timeLabel: 'measured'
    },
    {
      row: { uid: 'user-1', timestamp_epoch_seconds: 1100, row_index: 3 },
      deltaSeconds: 79,
      timeLabel: 'unknown'
    },
    {
      row: { uid: 'user-1', timestamp_epoch_seconds: 1205, row_index: 4 },
      deltaSeconds: 105,
      timeLabel: 'measured'
    },
    {
      row: { uid: 'user-1', timestamp_epoch_seconds: 1210, row_index: 5 },
      deltaSeconds: 5,
      timeLabel: 'measured'
    },
    {
      row: { uid: 'user-1', timestamp_epoch_seconds: 1211, row_index: 6 },
      deltaSeconds: 1,
      timeLabel: 'measured'
    },
    {
      row: { uid: 'user-1', timestamp_epoch_seconds: 1300, row_index: 7 },
      deltaSeconds: null,
      timeLabel: 'initial'
    }
  ];

  const makeSidCalls: Array<{ sequence: number; start: number }> = [];
  const assigned: SessionAnnotatedRow<TestRow>[] = assignSessions(userRows, 10, {
    makeSid: ({ uid, sessionSequence, sessionStartEpochSeconds }) => {
      makeSidCalls.push({ sequence: sessionSequence, start: sessionStartEpochSeconds });
      return `${uid}-${sessionSequence}-${sessionStartEpochSeconds}`;
    }
  });

  assert.equal(assigned.length, userRows.length);
  assert.deepEqual(
    assigned.map((row) => row.sessionSequence),
    [0, 0, 1, 1, 2, 2, 2, 3]
  );
  assert.deepEqual(
    assigned.map((row) => row.sessionIndex),
    [0, 1, 0, 1, 0, 1, 2, 0]
  );
  assert.deepEqual(
    assigned.map((row) => row.sessionId),
    [
      'user-1-0-1000',
      'user-1-0-1000',
      'user-1-1-1021',
      'user-1-1-1021',
      'user-1-2-1205',
      'user-1-2-1205',
      'user-1-2-1205',
      'user-1-3-1300'
    ]
  );
  assert.deepEqual(makeSidCalls, [
    { sequence: 0, start: 1000 },
    { sequence: 1, start: 1021 },
    { sequence: 2, start: 1205 },
    { sequence: 3, start: 1300 }
  ]);
});

test('assignSessions is stable and preserves row order metadata', () => {
  const userRows: DeltaAnnotatedRow<TestRow>[] = [
    {
      row: { uid: 'user-2', timestamp_epoch_seconds: 2000, row_index: 10 },
      deltaSeconds: null,
      timeLabel: 'initial'
    },
    {
      row: { uid: 'user-2', timestamp_epoch_seconds: 2004, row_index: 11 },
      deltaSeconds: 4,
      timeLabel: 'measured'
    },
    {
      row: { uid: 'user-2', timestamp_epoch_seconds: 2016, row_index: 12 },
      deltaSeconds: 12,
      timeLabel: 'measured'
    }
  ];

  const originalSnapshot = userRows.map((item) => ({
    row: { ...item.row },
    deltaSeconds: item.deltaSeconds,
    timeLabel: item.timeLabel
  }));

  const makeSid = ({ uid, sessionSequence, sessionStartEpochSeconds }: {
    uid: string;
    sessionSequence: number;
    sessionStartEpochSeconds: number;
  }): string => `${uid}-${sessionSequence}-${sessionStartEpochSeconds}`;

  const first = assignSessions(userRows, 10, { makeSid });
  const second = assignSessions(userRows, 10, { makeSid });

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((row) => row.row.row_index),
    userRows.map((row) => row.row.row_index)
  );
  assert.deepEqual(userRows, originalSnapshot);
});
