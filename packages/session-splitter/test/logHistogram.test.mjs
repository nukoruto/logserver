import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeLogHistogram } from '../dist/index.js';

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
