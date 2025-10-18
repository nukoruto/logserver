import { describe, expect, it } from 'vitest';

import { makeLogHistogram, otsuThreshold } from '../dist/index.js';
import type { LogHistogramResult } from '../dist/index.js';

describe('makeLogHistogram', () => {
  it('enforces minimum bin count of 32', () => {
  const dense = Array.from({ length: 48 }, (_: unknown, index) => 1 + index * 1e-6);
  const result = makeLogHistogram(dense);
    expect(result.binCount).toBe(32);
    expect(result.binEdges).toHaveLength(result.binCount + 1);
    expect(result.binCounts).toHaveLength(result.binCount);
  });

  it('enforces maximum bin count of 512', () => {
  const narrow = Array.from({ length: 4096 }, (_: unknown, index) => 1 + index * 1e-6);
  const tail = Array.from({ length: 32 }, (_: unknown, index) => 10 ** (index + 1));
  const result = makeLogHistogram([...narrow, ...tail]);
    expect(result.binCount).toBe(512);
    expect(result.binEdges).toHaveLength(result.binCount + 1);
    expect(result.binCounts).toHaveLength(result.binCount);
  });
});

describe('otsuThreshold', () => {
  it('returns stable log-domain boundary on bimodal mixture', () => {
  const binCount = 32;
  const logMin = 0;
  const logBinWidth = 0.25;
  const binCounts = Array.from({ length: binCount }, (_: unknown, index) => {
    if (index < 8) return 120;
    if (index >= 24) return 90;
    return 2;
  });
  const binEdges = Array.from({ length: binCount + 1 }, (_, index) => Math.exp(logMin + logBinWidth * index));
  const histogram: LogHistogramResult = {
    binEdges,
    binCounts,
    binCount,
    logBinWidth,
    domain: {
      min: binEdges[0],
      max: binEdges[binEdges.length - 1],
      logMin,
      logMax: logMin + binCount * logBinWidth
    }
  };
  const { tauLog, quality } = otsuThreshold(histogram);
    expect(Number.isFinite(tauLog)).toBe(true);
  const expectedLogBoundary = logMin + logBinWidth * 16;
    expect(Math.abs(tauLog - expectedLogBoundary)).toBeLessThan(1e-9);
    expect(quality).toBeGreaterThanOrEqual(0.9);
    expect(quality).toBeLessThanOrEqual(1.01);
  });
});
