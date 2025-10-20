import { describe, expect, it } from 'vitest';

import { chooseEpsilonMin } from '../src/epsilon.js';

describe('chooseEpsilonMin', () => {
  it('returns half of the smallest positive delta when within clip bounds', () => {
    const epsilon = chooseEpsilonMin([0.004, 0.006, 0.01]);
    // Smallest positive delta = 0.004 -> epsilon = 0.002 (within bounds)
    expect(epsilon).toBeCloseTo(0.002, 9);
  });

  it('clips epsilon to lower bound when min delta is extremely small', () => {
    const epsilon = chooseEpsilonMin([1e-9, 5e-8, 2e-7]);
    expect(epsilon).toBeCloseTo(1e-6, 12);
  });

  it('clips epsilon to upper bound when min delta is large', () => {
    const epsilon = chooseEpsilonMin([0.4, 1.2, 0.8]);
    expect(epsilon).toBeCloseTo(1e-2, 12);
  });

  it('ignores non-positive, NaN, and infinite values', () => {
    const epsilon = chooseEpsilonMin([Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 0.012]);
    expect(epsilon).toBeCloseTo(0.006, 12);
  });

  it('returns the lower bound when the halved minimum hits it exactly', () => {
    const epsilon = chooseEpsilonMin([2e-6, 1, 5]);
    expect(epsilon).toBeCloseTo(1e-6, 12);
  });

  it('falls back to the specification lower limit when no valid deltas exist', () => {
    const epsilon = chooseEpsilonMin([Number.NaN, Number.POSITIVE_INFINITY, -1, 0]);
    expect(epsilon).toBeCloseTo(1e-6, 12);
  });
});
