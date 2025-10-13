import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  clip,
  computeFeatureRows,
  freezeFittedStats,
  robustZ,
  thawFittedStats,
  type FrozenFittedStats,
  type LogRow,
  type RobustScaleStats
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

2test('thawFittedStats loads frozen per-uid robust log-delta statistics without recomputation', () => {
  const frozen = loadFrozenStats('robust_uid');
  const fitted = thawFittedStats(frozen);

  const epsilon = 0.5;
  const expectedGlobalLogs = [600, 3000, 60, 60, 1680, 1800, 200].map((value) => Math.log(value + epsilon));
  const expectedGlobal = summarize(expectedGlobalLogs);

  expectClose(fitted.epsilon, epsilon, 'epsilon');
  expectClose(fitted.global.x_med, expectedGlobal.x_med, 'global x_med');
  expectClose(fitted.global.x_mad, expectedGlobal.x_mad, 'global x_mad');
  expectClose(fitted.global.x_smad, expectedGlobal.x_smad, 'global x_smad');

  const byHourKeys = Object.keys(fitted.global.byHour);
  if (byHourKeys.length !== 24) {
    throw new Error(`global byHour count mismatch: ${byHourKeys.length}`);
  }

  const hour0 = fitted.global.byHour[0];
  const hour1 = fitted.global.byHour[1];
  const hour2 = fitted.global.byHour[2];
  const hour3 = fitted.global.byHour[3];
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
    const stats = fitted.global.byHour[hour];
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
  expectClose(userAStats!.byHour[0].x_med, Math.log(600 + epsilon), 'userA hour0 x_med');
  expectClose(userAStats!.byHour[1].x_med, Math.log(3000 + epsilon), 'userA hour1 x_med');

  const expectedUserBLogs = [60, 60, 1680, 1800, 200].map((value) => Math.log(value + epsilon));
  const expectedUserB = summarize(expectedUserBLogs);
  expectClose(userBStats!.x_med, expectedUserB.x_med, 'userB x_med');
  expectClose(userBStats!.x_mad, expectedUserB.x_mad, 'userB x_mad');
  expectClose(userBStats!.byHour[2].x_med, Math.log(60 + epsilon), 'userB hour2 x_med');
  expectClose(userBStats!.byHour[3].x_med, expectedHour3.x_med, 'userB hour3 x_med');

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
  expectClose(userASession!.byHour[0].x_med, Math.log(600 + epsilon), 'userA sess hour0');
  expectClose(userASession!.byHour[1].x_med, Math.log(3000 + epsilon), 'userA sess hour1');

  const expectedBSessBLogs = [60, 60, 1680].map((value) => Math.log(value + epsilon));
  const expectedBSessB = summarize(expectedBSessBLogs);
  expectClose(userBSessB!.x_med, expectedBSessB.x_med, 'userB sessB x_med');
  expectClose(userBSessB!.byHour[2].x_med, Math.log(60 + epsilon), 'userB sessB hour2');

  const expectedBSessCLogs = [Math.log(1800 + epsilon), Math.log(200 + epsilon)];
  const expectedBSessC = summarize(expectedBSessCLogs);
  expectClose(userBSessC!.x_med, expectedBSessC.x_med, 'userB sessC x_med');
  expectClose(userBSessC!.byHour[3].x_med, expectedBSessC.x_med, 'userB sessC hour3');
  expectClose(userBSessC!.byHour[5].x_med, expectedBSessC.x_med, 'userB sessC hour5 fallback', 1e-3);

  const canonical = freezeFittedStats(fitted);
  assert.deepEqual(canonical, freezeFittedStats(thawFittedStats(canonical)));
test('updateStatsStreaming keeps statistics frozen when alpha is zero', () => {
  const prev: RobustStats = { x_med: 10, x_smad: 2 };
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
  const prev: RobustStats = { x_med: 10, x_smad: 5 };
  const cfg: UpdateCfg = { alpha: 0.2, trim: { low: 1, high: 1 }, maxDrift: 0.1 };
  const next = updateStatsStreaming(1000, prev, cfg);
  assert.ok(next.meta);
  assert.equal(next.meta?.lastInput, 1000);
  assert.equal(next.meta?.lastTrimmed, 15);
  assert.ok(next.x_med >= 10);
  assert.ok(next.x_med <= 11); // 10% drift limit on base scale 10
  assert.ok(next.x_smad <= 5.5);
  assert.ok(next.meta?.updates.some((entry) => entry.field === 'x_med'));
});

test('updateStatsStreaming bounds per-step drift under repeated outliers', () => {
  let stats: RobustStats = { x_med: 8, x_smad: 4 };
  const cfg: UpdateCfg = { alpha: 0.3, trim: { low: 0.5, high: 0.5 }, maxDrift: 0.1 };
  for (let i = 0; i < 50; i += 1) {
    const next = updateStatsStreaming(1000, stats, cfg);
    const diff = Math.abs(next.x_med - stats.x_med);
    const baseScale = Math.max(Math.abs(stats.x_med), stats.x_smad, 1e-12);
    assert.ok(diff <= baseScale * cfg.maxDrift + 1e-9);
    stats = next;
  }
});
