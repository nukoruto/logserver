import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeLogHistogram, otsuThreshold } from '../dist/index.js';

test('makeLogHistogram enforces minimum bin count of 32', () => {
  const dense = Array.from({ length: 48 }, (_, index) => 1 + index * 1e-6);
  const result = makeLogHistogram(dense);
  assert.equal(result.binCount, 32);
  assert.equal(result.binEdges.length, result.binCount + 1);
  assert.equal(result.binCounts.length, result.binCount);
});

test('makeLogHistogram enforces maximum bin count of 512', () => {
  const narrow = Array.from({ length: 4096 }, (_, index) => 1 + index * 1e-6);
  const tail = Array.from({ length: 32 }, (_, index) => 10 ** (index + 1));
  const result = makeLogHistogram([...narrow, ...tail]);
  assert.equal(result.binCount, 512);
  assert.equal(result.binEdges.length, result.binCount + 1);
  assert.equal(result.binCounts.length, result.binCount);
});

test('otsuThreshold returns stable log-domain boundary on bimodal mixture', () => {
  const binCount = 32;
  const logMin = 0;
  const logBinWidth = 0.25;
  const binCounts = Array.from({ length: binCount }, (_, index) => {
    if (index < 8) return 120;
    if (index >= 24) return 90;
    return 2;
  });
  const binEdges = Array.from({ length: binCount + 1 }, (_, index) => Math.exp(logMin + logBinWidth * index));
  const histogram = {
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
  assert.ok(Number.isFinite(tauLog), 'tauLog must be finite');
  const expectedLogBoundary = logMin + logBinWidth * 16;
  assert.ok(Math.abs(tauLog - expectedLogBoundary) < 1e-9, `tauLog deviates from expected boundary: ${tauLog}`);
  assert.ok(quality >= 0.9, `quality should highlight strong separation, got ${quality}`);
  assert.ok(quality <= 1.01, `quality should not exceed 1 by margin, got ${quality}`);
});
