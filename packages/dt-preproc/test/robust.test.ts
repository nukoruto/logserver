import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clip,
  computeFeatureRows,
  robustZ,
  type LogRow,
  type RobustStats
} from '../src/index.js';

function createRow(uid: string, sessionId: string, epochSeconds: number, index: number): LogRow {
  return {
    timestamp_utc: new Date(epochSeconds * 1000).toISOString(),
    timestamp_epoch_seconds: epochSeconds,
    uid,
    session_id: sessionId,
    method: 'GET',
    path: '/resource',
    referer: '',
    user_agent: 'test-agent',
    ip: '127.0.0.1',
    op_category: 'READ',
    row_index: index
  };
}

function appendSession(
  rows: LogRow[],
  uid: string,
  sessionId: string,
  startEpoch: number,
  deltas: readonly number[],
  startIndex: number
): number {
  let index = startIndex;
  let current = startEpoch;
  rows.push(createRow(uid, sessionId, current, index));
  index += 1;
  for (const delta of deltas) {
    current += delta;
    rows.push(createRow(uid, sessionId, current, index));
    index += 1;
  }
  return index;
}

function computeMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function summarize(values: readonly number[]): RobustStats {
  if (values.length === 0) {
    throw new Error('values must not be empty');
  }
  const median = computeMedian(values);
  const deviations = values.map((value) => Math.abs(value - median));
  const mad = computeMedian(deviations);
  const smad = 1.4826 * mad;
  return { x_med: median, x_smad: smad };
}

test('clip clamps values symmetrically with default limit', () => {
  assert.equal(clip(10), 5);
  assert.equal(clip(-10), -5);
  assert.equal(clip(3.5), 3.5);
});

test('clip supports custom limit', () => {
  assert.equal(clip(10, 2), 2);
  assert.equal(clip(-10, 2), -2);
});

test('robust z-score falls back to global statistics when user variance is zero', () => {
  const rows: LogRow[] = [
    createRow('userA', 's1', 0, 0),
    createRow('userA', 's1', 10, 1),
    createRow('userA', 's1', 20, 2),
    createRow('userB', 's2', 0, 3),
    createRow('userB', 's2', 5, 4),
    createRow('userB', 's2', 25, 5)
  ];

  const { rows: features } = computeFeatureRows(rows, {
    clipMaxSeconds: 3600,
    robustScaleEpsilon: 1e-9,
    robustZClip: 5
  });

  const zValues = features
    .filter((row) => row.delta_clipped_seconds !== null)
    .map((row) => row.delta_robust_z);

  assert.ok(zValues.length > 0);
  for (const value of zValues) {
    assert.notEqual(value, null);
    const numeric = value as number;
    assert.ok(Number.isFinite(numeric));
    assert.ok(Math.abs(numeric) <= 5 + 1e-9);
  }

  const constantUser = features.filter((row) => row.uid === 'userA' && row.delta_robust_z !== null);
  for (const row of constantUser) {
    assert.ok(Math.abs(row.delta_robust_z as number) <= 1e-6);
  }
});

test('robust z-score is approximately invariant under unit scaling', () => {
  const values = [5, 10, 12, 20, 40, 55, 78, 120];
  const stats = summarize(values);
  const scale = 60;
  const scaledStats: RobustStats = {
    x_med: stats.x_med * scale,
    x_smad: stats.x_smad * scale
  };

  const baseZ = values.map((value) => clip(robustZ(value, stats)));
  const scaledZ = values.map((value) => clip(robustZ(value * scale, scaledStats)));

  for (let i = 0; i < baseZ.length; i += 1) {
    const diff = Math.abs(baseZ[i] - scaledZ[i]);
    assert.ok(diff <= 0.02, `z-score mismatch exceeds tolerance: ${diff}`);
  }
});

test('session-level stats back off to user aggregates when below minSamples', () => {
  const denseSession = [10, 12, 11, 9, 10, 14, 13, 10];
  const sparseSession = [100, 120, 80, 90, 110];
  const rows: LogRow[] = [];
  let index = 0;
  index = appendSession(rows, 'user-rich', 'dense', 0, denseSession, index);
  appendSession(rows, 'user-rich', 'sparse', 2000, sparseSession, index);

  const { rows: features } = computeFeatureRows(rows, {
    clipMaxSeconds: 3600,
    robustScaleEpsilon: 1e-9,
    robustZClip: 5,
    minSamples: 8
  });

  const measuredByUser = features
    .filter(
      (row) =>
        row.uid === 'user-rich' && row.delta_robust_z !== null && row.delta_time_label === 'measured'
    )
    .map((row) => row.delta_clipped_seconds as number);
  const expectedStats = summarize(measuredByUser);

  const sparseRows = features.filter(
    (row) =>
      row.uid === 'user-rich' &&
      row.session_id === 'sparse' &&
      row.delta_robust_z !== null &&
      row.delta_time_label === 'measured'
  );
  assert.ok(sparseRows.length > 0);

  for (let i = 0; i < sparseRows.length; i += 1) {
    const actualValue = sparseRows[i].delta_clipped_seconds as number;
    const expectedZ = clip(robustZ(actualValue, expectedStats));
    const actualZ = sparseRows[i].delta_robust_z as number;
    const diff = Math.abs(actualZ - expectedZ);
    assert.ok(diff <= 1e-6, `session fallback drift exceeds tolerance: ${diff}`);
  }
});

test('user-level stats back off to global aggregates when user is sparse', () => {
  const denseSession = [10, 12, 11, 9, 10, 14, 13, 10];
  const sparseSession = [100, 120, 80, 90, 110];
  const sparseUser = [45, 50, 55, 60, 65];
  const rows: LogRow[] = [];
  let index = 0;
  index = appendSession(rows, 'user-rich', 'dense', 0, denseSession, index);
  index = appendSession(rows, 'user-rich', 'sparse', 2000, sparseSession, index);
  appendSession(rows, 'user-scarce', 'solo', 4000, sparseUser, index);

  const { rows: features, stats } = computeFeatureRows(rows, {
    clipMaxSeconds: 3600,
    robustScaleEpsilon: 1e-9,
    robustZClip: 5,
    minSamples: 8
  });

  assert.notEqual(stats.deltaMedian, null);

  const globalMeasured = features
    .filter(
      (row) => row.delta_robust_z !== null && row.delta_time_label === 'measured'
    )
    .map((row) => row.delta_clipped_seconds as number);
  const globalStats = summarize(globalMeasured);

  const scarceRows = features.filter(
    (row) =>
      row.uid === 'user-scarce' &&
      row.delta_robust_z !== null &&
      row.delta_time_label === 'measured'
  );
  assert.ok(scarceRows.length > 0);

  for (let i = 0; i < scarceRows.length; i += 1) {
    const actualValue = scarceRows[i].delta_clipped_seconds as number;
    const expectedZ = clip(robustZ(actualValue, globalStats));
    const actualZ = scarceRows[i].delta_robust_z as number;
    const diff = Math.abs(actualZ - expectedZ);
    assert.ok(diff <= 1e-6, `global fallback drift exceeds tolerance: ${diff}`);
  }
});
