import { describe, expect, it } from 'vitest';
import {
  bimodalityTest,
  computeKneeCurve,
  kneeThreshold,
  makeLogHistogram,
  otsuThreshold
} from '../dist/index.js';

const SAMPLE_VALUES = [
  0.45,
  0.51,
  0.73,
  0.88,
  1.02,
  1.35,
  1.77,
  2.21,
  2.92,
  3.48,
  4.91,
  6.37,
  7.15,
  8.42,
  9.76,
  11.98,
  14.25,
  18.4,
  23.7,
  31.2
];

function computeSigmaLog(values: number[]): number {
  const logs = values.filter((value) => value > 0 && Number.isFinite(value)).map((value) => Math.log(value));
  const mean = logs.reduce((acc, value) => acc + value, 0) / logs.length;
  const variance = logs.reduce((acc, value) => acc + (value - mean) ** 2, 0) / logs.length;
  return Math.sqrt(Math.max(variance, 0));
}

describe('makeLogHistogram and otsuThreshold', () => {
  it('produces a stable histogram and Otsu threshold in log-space', () => {
    const histogram = makeLogHistogram(SAMPLE_VALUES);
    expect(histogram.binCount).toBeGreaterThan(0);
    expect(histogram.binEdges.length).toBe(histogram.binCount + 1);
    expect(histogram.binCounts.length).toBe(histogram.binCount);
    const totalCount = histogram.binCounts.reduce((acc, count) => acc + count, 0);
    expect(totalCount).toBe(SAMPLE_VALUES.length);
    expect(histogram.domain.min).toBeCloseTo(histogram.binEdges[0]);
    expect(histogram.domain.max).toBeCloseTo(histogram.binEdges[histogram.binEdges.length - 1]);
    expect(histogram.logBinWidth).toBeGreaterThan(0);

    const otsu = otsuThreshold(histogram);
    expect(Number.isFinite(otsu.tauLog)).toBe(true);
    expect(otsu.quality).toBeGreaterThanOrEqual(0);
    expect(otsu.tauLog).toBeGreaterThanOrEqual(histogram.domain.logMin);
    expect(otsu.tauLog).toBeLessThanOrEqual(histogram.domain.logMax);
  });
});

describe('kneeThreshold and computeKneeCurve', () => {
  it('detects a knee that matches the standalone computation', () => {
    const histogram = makeLogHistogram(SAMPLE_VALUES);
    const otsu = otsuThreshold(histogram);
    const sigmaLog = computeSigmaLog(SAMPLE_VALUES);
    const knee = kneeThreshold(SAMPLE_VALUES, otsu.tauLog, sigmaLog);
    expect(knee).toBeGreaterThan(Math.exp(otsu.tauLog) * 0.5);

    const curve = computeKneeCurve(SAMPLE_VALUES, otsu.tauLog, sigmaLog);
    expect(curve.points.length).toBeGreaterThan(0);
    expect(curve.knee.threshold).toBeGreaterThan(0);
    expect(Number.isFinite(curve.knee.logThreshold)).toBe(true);
    expect(curve.knee.threshold).toBeCloseTo(knee, 6);
  });
});

describe('bimodalityTest', () => {
  it('returns a positive BIC improvement for a bimodal distribution', () => {
    const bimodalLogs = [
      Math.log(0.5),
      Math.log(0.55),
      Math.log(0.6),
      Math.log(0.62),
      Math.log(0.65),
      Math.log(0.68),
      Math.log(0.7),
      Math.log(0.75),
      Math.log(0.8),
      Math.log(0.82),
      Math.log(0.85),
      Math.log(0.9),
      Math.log(0.95),
      Math.log(1.0),
      Math.log(1.05),
      Math.log(1.1),
      Math.log(8.1),
      Math.log(8.3),
      Math.log(8.6),
      Math.log(8.8),
      Math.log(9.0),
      Math.log(9.2),
      Math.log(9.5),
      Math.log(9.7),
      Math.log(9.9),
      Math.log(10.2),
      Math.log(10.5),
      Math.log(10.7),
      Math.log(11.0),
      Math.log(11.2),
      Math.log(11.5),
      Math.log(11.7),
      Math.log(12.0),
      Math.log(12.2),
      Math.log(12.5),
      Math.log(12.7),
      Math.log(13.0),
      Math.log(13.2),
      Math.log(13.5),
      Math.log(13.7)
    ];
    const result = bimodalityTest(bimodalLogs);
    expect(result.bicDifference).toBeGreaterThan(0);
  });

  it('falls back to -Infinity when insufficient samples are provided', () => {
    const result = bimodalityTest([0.1, 0.2, 0.3]);
    expect(result.bicDifference).toBe(Number.NEGATIVE_INFINITY);
  });
});
