import { describe, expect, test } from 'vitest';

import { rollingQuantilesR7 } from '../index.js';

const TOLERANCE = 5e-3;

function expectClose(actual: number, expected: number, message: string): void {
  const delta = Math.abs(actual - expected);
  expect(delta, message).toBeLessThanOrEqual(TOLERANCE);
}

describe('rollingQuantilesR7', () => {
  test('computes Hyndman-Fan R7 quantiles for canonical sample', () => {
    const sample = [1, 2, 3, 4];
    const expected = [1.75, 2.5, 3.25];
    const actual = rollingQuantilesR7(sample);

    actual.forEach((value, index) => {
      expectClose(value, expected[index], `quantile[${index}]`);
    });
  });

  test('handles leading edges without NaN and matches available data', () => {
    const single = [10];
    const [q1, q2, q3] = rollingQuantilesR7(single);
    expect(q1).toBe(10);
    expect(q2).toBe(10);
    expect(q3).toBe(10);
  });

  test('ignores non-finite values and clamps probabilities', () => {
    const sample = [Number.NaN, Number.POSITIVE_INFINITY, -2, 8];
    const expected = [-2, 3, 8];
    const actual = rollingQuantilesR7(sample, [-0.5, 0.5, 1.5]);

    actual.forEach((value, index) => {
      expectClose(value, expected[index], `quantile_with_clamp[${index}]`);
    });
  });

  test('remains monotonic for heavy-tailed and skewed samples', () => {
    const sample = [1e-6, 0.2, 5, 10, 100, 1e6];
    const actual = rollingQuantilesR7(sample);
    expect(actual[0]).toBeLessThanOrEqual(actual[1]);
    expect(actual[1]).toBeLessThanOrEqual(actual[2]);
    expect(actual[0]).toBeGreaterThan(0);
    expect(actual[2]).toBeLessThanOrEqual(1e6);
  });

  test('matches sorted order even when inputs arrive unsorted', () => {
    const sample = [5, -5, 20, 7, -3, 0];
    const expected = rollingQuantilesR7([...sample].sort((a, b) => a - b));
    const actual = rollingQuantilesR7(sample);
    actual.forEach((value, index) => {
      expectClose(value, expected[index], `unsorted[${index}]`);
    });
  });
});
