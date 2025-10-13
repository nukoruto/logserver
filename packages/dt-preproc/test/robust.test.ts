import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import {
  clip,
  computeFeatureRows,
  fitRobustStats,
  freezeFittedStats,
  robustZ,
  StreamingFeatureTransformer,
  thawFittedStats,
  updateStatsStreaming,
  type FrozenFittedStats,
  type LogRow,
  type LogRowWithFeats,
  type RobustScaleStats,
  type RobustStats,
  type UpdateCfg
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

function projectRows(rows: readonly LogRowWithFeats[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    uid: row.uid,
    session_id: row.session_id,
    row_index: row.row_index,
    delta_seconds: row.delta_seconds,
    delta_clipped_seconds: row.delta_clipped_seconds,
    delta_robust_z: row.delta_robust_z,
    delta_z_deseas_clipped: row.delta_z_deseas_clipped,
    delta_log_burst: row.delta_log_burst,
    delta_time_label: row.delta_time_label,
    session_sequence: row.session_sequence,
    session_elapsed_seconds: row.session_elapsed_seconds,
    is_session_start: row.is_session_start
  }));
}

function computeMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function summarize(values: readonly number[]): RobustScaleStats {
  if (values.length === 0) {
    throw new Error('values must not be empty');
  }
  const median = computeMedian(values);
  const deviations = values.map((value) => Math.abs(value - median));
  const mad = computeMedian(deviations);
  const smad = 1.4826 * mad;
  return { x_med: median, x_mad: mad, x_smad: smad };
}

function approxEqual(a: number, b: number, tolerance = 1e-6): boolean {
  return Math.abs(a - b) <= tolerance;
}

function expectClose(actual: number, expected: number, label: string, tolerance = 1e-6): void {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${label} mismatch: diff=${diff}`);
  }
}

function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length === 0) {
    throw new Error('correlation requires non-empty arrays of equal length');
  }
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) {
    return 0;
  }
  return num / Math.sqrt(denomX * denomY);
}

function loadFrozenStats(name: string): FrozenFittedStats {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  const text = readFileSync(fileURLToPath(url), 'utf-8');
  return JSON.parse(text) as FrozenFittedStats;
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

test('computeFeatureRows normalizes epsilon inputs', () => {
  const baseline = computeFeatureRows([], {});
  expect(baseline.options.epsilon).toBeCloseTo(0.0005, 6);
  expect(baseline.options.epsilonT).toBeCloseTo(0.05, 6);

  const { options } = computeFeatureRows([], { epsilon: -5, epsilonT: -1, clipMaxSeconds: -10 });
  expect(options.epsilon).toBe(0);
  expect(options.epsilonT).toBe(0);
  expect(options.clipMaxSeconds).toBe(300);
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

  const deseasValues = features
    .filter((row) => row.delta_z_deseas_clipped !== null)
    .map((row) => row.delta_z_deseas_clipped as number);
  for (const value of deseasValues) {
    assert.ok(Number.isFinite(value));
    assert.ok(Math.abs(value) <= 5 + 1e-9);
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
  const scaledStats: RobustScaleStats = {
    x_med: stats.x_med * scale,
    x_mad: stats.x_mad * scale,
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

test('seasonal residual reduces correlation with global z', () => {
  const base = 3600;
  const amplitude = 900;
  const rows: LogRow[] = [];
  let index = 0;
  let current = 0;
  rows.push(createRow('seasonal-user', 'seasonal-session', current, index));
  index += 1;

  const totalCycles = 3;
  for (let cycle = 0; cycle < totalCycles; cycle += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const seasonal = amplitude * Math.sin((2 * Math.PI * hour) / 24);
      const noise = ((hour % 3) - 1) * 15;
      const deltaSeconds = Math.max(60, Math.round(base + seasonal + noise));
      current += deltaSeconds;
      rows.push(createRow('seasonal-user', 'seasonal-session', current, index));
      index += 1;
    }
  }

  const { rows: features } = computeFeatureRows(rows, {
    clipMaxSeconds: 7200,
    robustScaleEpsilon: 1e-9,
    robustZClip: 5,
    minSamples: 8
  });

  const measured = features.filter(
    (row) =>
      row.delta_time_label === 'measured' &&
      row.delta_robust_z !== null &&
      row.delta_z_deseas_clipped !== null
  );

  const globalZ = measured.map((row) => row.delta_robust_z as number);
  const seasonalZ = measured.map((row) => row.delta_z_deseas_clipped as number);

  assert.ok(globalZ.length > 0);
  const correlation = Math.abs(pearsonCorrelation(globalZ, seasonalZ));
  assert.ok(correlation < 0.9, `correlation too high: ${correlation}`);
});

test('thawFittedStats loads frozen per-uid robust log-delta statistics without recomputation', () => {
  const frozen = loadFrozenStats('robust_uid');
  const fitted = thawFittedStats(frozen);

  const epsilon = 0.5;
  const expectedGlobalLogs = [600, 3000, 60, 60, 1680, 1800, 200].map((value) => Math.log(value + epsilon));
  const expectedGlobal = summarize(expectedGlobalLogs);

  expectClose(fitted.epsilon, epsilon, 'epsilon');
  assert.ok(fitted.global, 'global stats should be present');
  const globalStats = fitted.global as RobustStats;
  expectClose(globalStats.x_med, expectedGlobal.x_med, 'global x_med');
  expectClose(globalStats.x_mad, expectedGlobal.x_mad, 'global x_mad');
  expectClose(globalStats.x_smad, expectedGlobal.x_smad, 'global x_smad');

  const byHour = globalStats.byHour ?? {};
  const byHourKeys = Object.keys(byHour);
  if (byHourKeys.length !== 24) {
    throw new Error(`global byHour count mismatch: ${byHourKeys.length}`);
  }

  const hour0 = byHour[0];
  const hour1 = byHour[1];
  const hour2 = byHour[2];
  const hour3 = byHour[3];
  expectClose(hour0.x_med, Math.log(600 + epsilon), 'hour0 x_med');
  expectClose(hour0.x_mad, 0, 'hour0 x_mad');
  expectClose(hour1.x_med, Math.log(3000 + epsilon), 'hour1 x_med');
  expectClose(hour2.x_med, Math.log(60 + epsilon), 'hour2 x_med');
  const expectedHour3 = summarize([Math.log(1800 + epsilon), Math.log(200 + epsilon)]);
  expectClose(hour3.x_med, expectedHour3.x_med, 'hour3 x_med');

  for (let hour = 0; hour < 24; hour += 1) {
    if (hour === 0 || hour === 1 || hour === 2 || hour === 3) {
      continue;
    }
    const stats = byHour[hour];
    expectClose(stats.x_med, expectedGlobal.x_med, `hour${hour} x_med fallback`, 1e-3);
    expectClose(stats.x_mad, expectedGlobal.x_mad, `hour${hour} x_mad fallback`, 1e-3);
    expectClose(stats.x_smad, expectedGlobal.x_smad, `hour${hour} x_smad fallback`, 1e-3);
  }

  if (fitted.groups.size !== 2) {
    throw new Error(`group count mismatch: ${fitted.groups.size}`);
  }
  const userAKey = JSON.stringify({ uid: 'userA' });
  const userBKey = JSON.stringify({ uid: 'userB' });
  const userAStats = fitted.groups.get(userAKey);
  const userBStats = fitted.groups.get(userBKey);
  assert.ok(userAStats);
  assert.ok(userBStats);

  const expectedUserA = summarize([Math.log(600 + epsilon), Math.log(3000 + epsilon)]);
  expectClose(userAStats!.x_med, expectedUserA.x_med, 'userA x_med');
  expectClose(userAStats!.x_mad, expectedUserA.x_mad, 'userA x_mad');
  const userAByHour = userAStats!.byHour;
  if (!userAByHour) {
    throw new Error('userA byHour missing');
  }
  expectClose(userAByHour[0].x_med, Math.log(600 + epsilon), 'userA hour0 x_med');
  expectClose(userAByHour[1].x_med, Math.log(3000 + epsilon), 'userA hour1 x_med');

  const expectedUserBLogs = [60, 60, 1680, 1800, 200].map((value) => Math.log(value + epsilon));
  const expectedUserB = summarize(expectedUserBLogs);
  expectClose(userBStats!.x_med, expectedUserB.x_med, 'userB x_med');
  expectClose(userBStats!.x_mad, expectedUserB.x_mad, 'userB x_mad');
  const userBByHour = userBStats!.byHour;
  if (!userBByHour) {
    throw new Error('userB byHour missing');
  }
  expectClose(userBByHour[2].x_med, Math.log(60 + epsilon), 'userB hour2 x_med');
  expectClose(userBByHour[3].x_med, expectedHour3.x_med, 'userB hour3 x_med');

  const canonical = freezeFittedStats(fitted);
  assert.deepEqual(canonical, freezeFittedStats(thawFittedStats(canonical)));
});

test('thawFittedStats supports uid+session grouping from frozen fixture', () => {
  const frozen = loadFrozenStats('robust_uid_session');
  const fitted = thawFittedStats(frozen);

  if (fitted.groups.size !== 3) {
    throw new Error(`uid+session group count mismatch: ${fitted.groups.size}`);
  }

  const epsilon = 0.5;
  const userASessionKey = JSON.stringify({ uid: 'userA', session_id: 'sessA' });
  const userBSessBKey = JSON.stringify({ uid: 'userB', session_id: 'sessB' });
  const userBSessCKey = JSON.stringify({ uid: 'userB', session_id: 'sessC' });

  const userASession = fitted.groups.get(userASessionKey);
  const userBSessB = fitted.groups.get(userBSessBKey);
  const userBSessC = fitted.groups.get(userBSessCKey);
  assert.ok(userASession);
  assert.ok(userBSessB);
  assert.ok(userBSessC);

  const expectedASession = summarize([Math.log(600 + epsilon), Math.log(3000 + epsilon)]);
  expectClose(userASession!.x_med, expectedASession.x_med, 'userA sess x_med');
  const userASessionByHour = userASession!.byHour;
  if (!userASessionByHour) {
    throw new Error('userA session byHour missing');
  }
  expectClose(userASessionByHour[0].x_med, Math.log(600 + epsilon), 'userA sess hour0');
  expectClose(userASessionByHour[1].x_med, Math.log(3000 + epsilon), 'userA sess hour1');

  const expectedBSessBLogs = [60, 60, 1680].map((value) => Math.log(value + epsilon));
  const expectedBSessB = summarize(expectedBSessBLogs);
  expectClose(userBSessB!.x_med, expectedBSessB.x_med, 'userB sessB x_med');
  const userBSessBByHour = userBSessB!.byHour;
  if (!userBSessBByHour) {
    throw new Error('userB sessB byHour missing');
  }
  expectClose(userBSessBByHour[2].x_med, Math.log(60 + epsilon), 'userB sessB hour2');

  const expectedBSessCLogs = [Math.log(1800 + epsilon), Math.log(200 + epsilon)];
  const expectedBSessC = summarize(expectedBSessCLogs);
  expectClose(userBSessC!.x_med, expectedBSessC.x_med, 'userB sessC x_med');
  const userBSessCByHour = userBSessC!.byHour;
  if (!userBSessCByHour) {
    throw new Error('userB sessC byHour missing');
  }
  expectClose(userBSessCByHour[3].x_med, expectedBSessC.x_med, 'userB sessC hour3');
  expectClose(userBSessCByHour[5].x_med, expectedBSessC.x_med, 'userB sessC hour5 fallback', 1e-3);

  const canonical = freezeFittedStats(fitted);
  assert.deepEqual(canonical, freezeFittedStats(thawFittedStats(canonical)));
});
test('updateStatsStreaming keeps statistics frozen when alpha is zero', () => {
  const prev: RobustStats = { x_med: 10, x_mad: 0, x_smad: 2 };
  const cfg: UpdateCfg = { alpha: 0, trim: { low: 1, high: 1 }, maxDrift: 0.1 };
  const next = updateStatsStreaming(100, prev, cfg);
  assert.deepEqual(next.x_med, prev.x_med);
  assert.deepEqual(next.x_smad, prev.x_smad);
  assert.ok(next.meta);
  assert.equal(next.meta?.updates.length, 0);
  assert.equal(next.meta?.lastInput, 100);
  assert.equal(next.meta?.lastTrimmed, 100);
});

test('updateStatsStreaming trims extremes and respects drift limit', () => {
  const prev: RobustStats = { x_med: 10, x_mad: 0, x_smad: 5 };
  const cfg: UpdateCfg = { alpha: 0.2, trim: { low: 1, high: 1 }, maxDrift: 0.1 };
  const next = updateStatsStreaming(1000, prev, cfg);
  assert.ok(next.meta);
  assert.equal(next.meta?.lastInput, 1000);
  assert.equal(next.meta?.lastTrimmed, 15);
  assert.ok(next.x_med >= 10);
  assert.ok(next.x_med <= 11); // 10% drift limit on base scale 10
  assert.ok(next.x_smad <= 5.5);
  const updates = next.meta?.updates ?? [];
  assert.ok(updates.some((entry) => entry.field === 'x_med'));
});

test('updateStatsStreaming bounds per-step drift under repeated outliers', () => {
  let stats: RobustStats = { x_med: 8, x_mad: 0, x_smad: 4 };
  const cfg: UpdateCfg = { alpha: 0.3, trim: { low: 0.5, high: 0.5 }, maxDrift: 0.1 };
  for (let i = 0; i < 50; i += 1) {
    const next = updateStatsStreaming(1000, stats, cfg);
    const diff = Math.abs(next.x_med - stats.x_med);
    const baseScale = Math.max(Math.abs(stats.x_med), stats.x_smad, 1e-12);
    assert.ok(diff <= baseScale * cfg.maxDrift + 1e-9);
    stats = next;
  }
});

test('computeFeatureRows is deterministic for identical inputs', () => {
  const rows: LogRow[] = [];
  let index = 0;
  index = appendSession(rows, 'userDet', 'sess1', 1_000, [1, 5, 2, 60], index);
  appendSession(rows, 'userDet', 'sess2', 5_000, [2, 2, 180, 5, 1], index);

  const first = computeFeatureRows(rows, { clipMaxSeconds: 300, robustZClip: 4 });
  const second = computeFeatureRows([...rows], { clipMaxSeconds: 300, robustZClip: 4 });

  expect(projectRows(first.rows)).toEqual(projectRows(second.rows));
  expect(first.options).toEqual(second.options);
  expect(first.stats).toEqual(second.stats);
});

test('StreamingFeatureTransformer maintains prefix stability (causality)', () => {
  const rows: LogRow[] = [];
  let index = 0;
  index = appendSession(rows, 'userA', 'sessA', 10_000, [30, 40, 50], index);
  index = appendSession(rows, 'userB', 'sessB', 20_000, [5, 60, 5, 600], index);
  appendSession(rows, 'userC', 'sessC', 30_000, [1, 1, 1], index);

  const fitted = fitRobustStats(rows, { epsilon: 0.5, epsilon_t: 0.05, grouping: 'uid_session', min_samples: 1 });
  const options = { epsilon: 0.5, epsilonT: 0.05, clipMaxSeconds: 300, robustZClip: 4, minSamples: 1 };

  const fullTransformer = new StreamingFeatureTransformer({ fitted, grouping: 'uid_session', ...options });
  const fullRows = rows.map((row) => fullTransformer.process({ ...row }));

  for (let prefix = 1; prefix <= rows.length; prefix += 1) {
    const transformer = new StreamingFeatureTransformer({ fitted, grouping: 'uid_session', ...options });
    const subsetRows = rows.slice(0, prefix).map((row) => transformer.process({ ...row }));
    expect(projectRows(subsetRows)).toEqual(projectRows(fullRows.slice(0, prefix)));
  }
});

test('StreamingFeatureTransformer matches thawed statistics replay', () => {
  const rows: LogRow[] = [];
  let index = 0;
  index = appendSession(rows, 'userA', 's1', 1_000, [1, 5, 2, 6, 2], index);
  index = appendSession(rows, 'userB', 's2', 2_000, [3, 4, 7, 1, 2, 5], index);
  index = appendSession(rows, 'userA', 's3', 3_500, [2, 2, 9, 3, 4], index);

  const options = {
    epsilon: 0.5,
    epsilonT: 1.0,
    clipMaxSeconds: 120,
    robustZClip: 4,
    minSamples: 1
  };

  const fitted = fitRobustStats(rows, {
    epsilon: options.epsilon,
    epsilon_t: options.epsilonT,
    grouping: 'uid_session',
    min_samples: options.minSamples
  });

  const transformerA = new StreamingFeatureTransformer({
    fitted,
    grouping: 'uid_session',
    epsilon: options.epsilon,
    epsilonT: options.epsilonT,
    clipMaxSeconds: options.clipMaxSeconds,
    robustZClip: options.robustZClip,
    minSamples: options.minSamples
  });

  const firstPass = rows.map((row) => transformerA.process(row));
  const statsA = transformerA.getStats();

  const frozen = freezeFittedStats(fitted);
  const thawed = thawFittedStats(frozen);

  const transformerB = new StreamingFeatureTransformer({
    fitted: thawed,
    grouping: 'uid_session',
    epsilon: options.epsilon,
    epsilonT: options.epsilonT,
    clipMaxSeconds: options.clipMaxSeconds,
    robustZClip: options.robustZClip,
    minSamples: options.minSamples
  });

  const secondPass = rows.map((row) => transformerB.process(row));
  const statsB = transformerB.getStats();

  assert.equal(secondPass.length, firstPass.length);
  for (let i = 0; i < firstPass.length; i += 1) {
    const a = firstPass[i];
    const b = secondPass[i];
    assert.deepEqual(
      {
        delta_seconds: a.delta_seconds,
        delta_clipped_seconds: a.delta_clipped_seconds,
        delta_robust_z: a.delta_robust_z,
        delta_z_deseas_clipped: a.delta_z_deseas_clipped,
        delta_log_burst: a.delta_log_burst,
        delta_time_label: a.delta_time_label,
        session_sequence: a.session_sequence,
        session_elapsed_seconds: a.session_elapsed_seconds,
        is_session_start: a.is_session_start
      },
      {
        delta_seconds: b.delta_seconds,
        delta_clipped_seconds: b.delta_clipped_seconds,
        delta_robust_z: b.delta_robust_z,
        delta_z_deseas_clipped: b.delta_z_deseas_clipped,
        delta_log_burst: b.delta_log_burst,
        delta_time_label: b.delta_time_label,
        session_sequence: b.session_sequence,
        session_elapsed_seconds: b.session_elapsed_seconds,
        is_session_start: b.is_session_start
      }
    );
  }

  assert.deepEqual(statsA, statsB);
});
