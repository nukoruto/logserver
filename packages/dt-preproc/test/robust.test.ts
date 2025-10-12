import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clip,
  computeFeatureRows,
  robustZ,
  updateStatsStreaming,
  type LogRow,
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
