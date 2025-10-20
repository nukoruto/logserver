import { describe, expect, test } from 'vitest';

import { lburst } from '../src/math.js';

describe('lburst', () => {
  test('returns zero when both deltas vanish', () => {
    expect(lburst(0, 0, 1e-3)).toBe(0);
  });

  test('clamps large positive ratio to clip bound', () => {
    expect(lburst(10, 0.001, 1e-3)).toBe(5);
  });

  test('clamps large negative ratio to clip bound', () => {
    expect(lburst(0.001, 10, 1e-3)).toBe(-5);
  });

  test('handles alternating minima and maxima without divergence', () => {
    const eps = 1e-4;
    const sequence: Array<[number, number]> = [
      [0.001, 2],
      [2, 0.001],
      [0.001, 2],
      [2, 0.001]
    ];
    for (const [prev, current] of sequence) {
      const value = lburst(prev, current, eps);
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThanOrEqual(5);
    }
  });

  test('uses epsilon floor to avoid division by zero for extreme ratios', () => {
    const eps = 1e-6;
    const burst = lburst(1e-9, 1e9, eps, 7);
    expect(Number.isFinite(burst)).toBe(true);
    expect(Math.abs(burst)).toBeLessThanOrEqual(7);
  });
});
