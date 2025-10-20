import { describe, expect, it } from 'vitest';

import { gpSurvival, pValueRef, spotThreshold } from '../src/spot.js';

describe('Generalized Pareto limit behaviour', () => {
  it('spotThreshold matches exponential limit as xi approaches 0', () => {
    const u = Math.log(5);
    const beta = 0.7;
    const pRef = 0.01;
    const q = 0.0025;
    const expected = u + beta * Math.log(pRef / q);

    const xiTiny = 1e-14;
    const thresholdTinyXi = spotThreshold(u, xiTiny, beta, pRef, q);
    expect(thresholdTinyXi).toBeCloseTo(expected, 12);

    const xiNegTiny = -1e-14;
    const thresholdNegTinyXi = spotThreshold(u, xiNegTiny, beta, pRef, q);
    expect(thresholdNegTinyXi).toBeCloseTo(expected, 12);
  });

  it('pValueRef follows exponential tail as xi approaches 0', () => {
    const y = 1.5;
    const beta = 0.7;
    const pRef = 0.01;
    const expected = pRef * Math.exp(-y / beta);

    const xiTiny = 1e-14;
    expect(pValueRef(y, xiTiny, beta, pRef)).toBeCloseTo(expected, 12);

    const xiNegTiny = -1e-14;
    expect(pValueRef(y, xiNegTiny, beta, pRef)).toBeCloseTo(expected, 12);

    expect(gpSurvival(y, 0, beta)).toBeCloseTo(Math.exp(-y / beta), 12);
  });
});
