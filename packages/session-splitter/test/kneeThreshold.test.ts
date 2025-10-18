import { describe, expect, it } from 'vitest';

import { kneeThreshold, makeLogHistogram, otsuThreshold } from '../dist/index.js';

function computeSigmaLog(values: readonly number[]): number {
  const logValues = values.map((value) => Math.log(value));
  const mean = logValues.reduce((acc, value) => acc + value, 0) / logValues.length;
  const variance = logValues.reduce((acc, value) => acc + (value - mean) ** 2, 0) / logValues.length;
  return Math.sqrt(Math.max(0, variance));
}

describe('kneeThreshold', () => {
  it('is stable for noisy staircase curves', () => {
  const base = [
    0.6,
    0.7,
    0.72,
    0.8,
    0.85,
    1,
    3,
    3.1,
    3.3,
    3.35,
    12,
    12.4,
    12.8,
    13.1,
    14.5
  ].sort((a, b) => a - b);

  const noisy = [
    0.58,
    0.71,
    0.75,
    0.81,
    0.9,
    1.05,
    3.05,
    3.12,
    3.4,
    3.5,
    12.2,
    12.6,
    12.9,
    13.5,
    14.8
  ].sort((a, b) => a - b);

  const histogramBase = makeLogHistogram(base);
  const histogramNoisy = makeLogHistogram(noisy);
  const { tauLog: tauBase } = otsuThreshold(histogramBase);
  const { tauLog: tauNoisy } = otsuThreshold(histogramNoisy);
  const sigmaBase = computeSigmaLog(base);
  const sigmaNoisy = computeSigmaLog(noisy);

  const kneeBase = kneeThreshold(base, tauBase, sigmaBase);
  const kneeNoisy = kneeThreshold(noisy, tauNoisy, sigmaNoisy);

    expect(Number.isFinite(kneeBase)).toBe(true);
    expect(Number.isFinite(kneeNoisy)).toBe(true);
    expect(kneeBase).toBeGreaterThanOrEqual(2);
    expect(kneeBase).toBeLessThanOrEqual(6);
    expect(kneeNoisy).toBeGreaterThanOrEqual(2);
    expect(kneeNoisy).toBeLessThanOrEqual(6);
    expect(Math.abs(kneeBase - kneeNoisy)).toBeLessThan(0.5);
  });
});
