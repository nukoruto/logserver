import test from 'node:test';
import assert from 'node:assert/strict';

import { rollingQuantilesR7 } from '../index.js';

const TOLERANCE = 5e-3;

function assertClose(actual: number, expected: number, message: string): void {
  const delta = Math.abs(actual - expected);
  assert.ok(delta <= TOLERANCE, `${message}: expected ${expected}, received ${actual} (|Δ|=${delta})`);
}

test('computes Hyndman-Fan R7 quantiles for canonical sample', () => {
  const sample = [1, 2, 3, 4];
  const expected = [1.75, 2.5, 3.25];
  const actual = rollingQuantilesR7(sample);

  actual.forEach((value, index) => {
    assertClose(value, expected[index], `quantile[${index}]`);
  });
});

test('handles leading edges without NaN and matches available data', () => {
  const single = [10];
  const [q1, q2, q3] = rollingQuantilesR7(single);
  assert.equal(q1, 10);
  assert.equal(q2, 10);
  assert.equal(q3, 10);
});

test('ignores non-finite values and clamps probabilities', () => {
  const sample = [Number.NaN, Number.POSITIVE_INFINITY, -2, 8];
  const expected = [-2, 3, 8];
  const actual = rollingQuantilesR7(sample, [-0.5, 0.5, 1.5]);

  actual.forEach((value, index) => {
    assertClose(value, expected[index], `quantile_with_clamp[${index}]`);
  });
});
