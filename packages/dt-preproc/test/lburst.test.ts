import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lburst } from '../src/math.js';

test('lburst returns zero when both deltas vanish', () => {
  const value = lburst(0, 0, 1e-3);
  assert.equal(value, 0);
});

test('lburst clamps large positive ratio to clip bound', () => {
  const value = lburst(10, 0.001, 1e-3);
  assert.equal(value, 5);
});

test('lburst clamps large negative ratio to clip bound', () => {
  const value = lburst(0.001, 10, 1e-3);
  assert.equal(value, -5);
});

test('lburst handles alternating minima and maxima without divergence', () => {
  const eps = 1e-4;
  const sequence: Array<[number, number]> = [
    [0.001, 2],
    [2, 0.001],
    [0.001, 2],
    [2, 0.001]
  ];
  for (const [prev, current] of sequence) {
    const value = lburst(prev, current, eps);
    assert.ok(Number.isFinite(value));
    assert.ok(Math.abs(value) <= 5);
  }
});
