import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  algoVersion,
  bimodalityTest,
  estimateThresholdsByUser,
  kneeThreshold,
  makeLogHistogram,
  otsuThreshold
} from '../dist/index.js';

function buildUnimodalDeltas(count) {
  const values = Array.from({ length: count }, (_, index) => 1 + (index % 5) * 1e-4);
  return values.sort((a, b) => a - b);
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  const position = clamped * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

test('unimodal distributions fall back to knee threshold', () => {
  const deltas = buildUnimodalDeltas(240);
  const rows = deltas.map((delta, index) => ({
    algo_ver: algoVersion,
    uid: 'user-1',
    generatedSessionId: 'user-1#0',
    sessionSequence: 0,
    sessionIndex: index,
    timestampUtc: '2024-01-01T00:00:00.000Z',
    deltaSeconds: delta,
    idleTimeoutSeconds: 1800,
    splitReason: 'continuous',
    original: {}
  }));

  const thresholds = estimateThresholdsByUser(rows, { minimumSamples: 5, fallbackPercentile: 0.95 });
  assert.equal(thresholds.algo_ver, algoVersion);
  const actual = thresholds.get('user-1');
  assert.ok(Number.isFinite(actual));

  const logValues = deltas.map((value) => Math.log(value));
  const { bicDifference } = bimodalityTest(logValues);
  const histogram = makeLogHistogram(deltas);
  const { tauLog, quality } = otsuThreshold(histogram);
  const shouldUseKnee = bicDifference <= 0 || quality < 0.25;
  assert.ok(shouldUseKnee, 'bimodality test should request knee fallback for unimodal data');

  const sigmaLog = (() => {
    const mean = logValues.reduce((acc, value) => acc + value, 0) / logValues.length;
    const variance = logValues.reduce((acc, value) => acc + (value - mean) ** 2, 0) / logValues.length;
    return Math.sqrt(Math.max(0, variance));
  })();
  const expectedKnee = kneeThreshold(deltas, tauLog, sigmaLog);
  const expectedQuantile = percentile(deltas, 0.95);
  const expected = Math.max(expectedKnee, expectedQuantile);
  assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${expected}, received ${actual}`);
});
