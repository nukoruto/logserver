import { describe, expect, test } from 'vitest';

import { rollingQuantilesR7 } from '../index.js';

const TOLERANCE = 5e-3;
const Z_QUARTILE = 0.6744897501960817;

function expectClose(actual: number, expected: number, message: string, tolerance = TOLERANCE): void {
  const delta = Math.abs(actual - expected);
  expect(delta, message).toBeLessThanOrEqual(tolerance);
}

function inverseStandardNormal(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError('p must be in (0, 1)');
  }
  const a = [
    -3.969683028665376e+01,
    2.209460984245205e+02,
    -2.759285104469687e+02,
    1.383577518672690e+02,
    -3.066479806614716e+01,
    2.506628277459239e+00
  ];
  const b = [
    -5.447609879822406e+01,
    1.615858368580409e+02,
    -1.556989798598866e+02,
    6.680131188771972e+01,
    -1.328068155288572e+01
  ];
  const c = [
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e+00,
    -2.549732539343734e+00,
    4.374664141464968e+00,
    2.938163982698783e+00
  ];
  const d = [
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e+00,
    3.754408661907416e+00
  ];

  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    const numerator = ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5];
    const denominator = ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return -numerator / denominator;
  }

  const q = p - 0.5;
  const r = q * q;
  const numerator = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q;
  const denominator = ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1;
  return numerator / denominator;
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

  test('lognormal samples yield log-Δt quantiles consistent with μ and σ', () => {
    const mu = -1.6;
    const sigma = 0.45;
    const count = 256;
    const probabilities = Array.from({ length: count }, (_, index) => (index + 0.5) / count);
    const logValues = probabilities.map((p) => mu + sigma * inverseStandardNormal(p));

    const [q1, q2, q3] = rollingQuantilesR7(logValues);
    const expectedQ1 = mu - sigma * Z_QUARTILE;
    const expectedQ3 = mu + sigma * Z_QUARTILE;

    expectClose(q2, mu, 'median_log', 0.02);
    expectClose(q1, expectedQ1, 'q1_log', 0.03);
    expectClose(q3, expectedQ3, 'q3_log', 0.03);

    const estimatedSigma = (q3 - q1) / (2 * Z_QUARTILE);
    expectClose(estimatedSigma, sigma, 'sigma_from_iqr', 0.03);
  });
});
