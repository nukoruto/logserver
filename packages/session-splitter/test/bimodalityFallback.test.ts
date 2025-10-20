import { describe, expect, it } from 'vitest';

import {
  algoVersion,
  bimodalityTest,
  estimateThresholdsByUser,
  kneeThreshold,
  makeSid,
  makeLogHistogram,
  otsuThreshold,
  deriveDatasetKey
} from '../dist/index.js';

type SessionRow = {
  algo_ver: typeof algoVersion;
  uid: string;
  generatedSessionId: string;
  sessionSequence: number;
  sessionIndex: number;
  timestampUtc: string;
  deltaSeconds: number | null;
  idleTimeoutSeconds: number;
  splitReason: 'continuous';
  original: Record<string, unknown>;
};

function buildUnimodalDeltas(count: number): number[] {
  const values = Array.from({ length: count }, (_, index) => 1 + (index % 5) * 1e-4);
  return values.sort((a, b) => a - b);
}

function percentile(sortedValues: readonly number[], fraction: number): number {
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

describe('bimodality fallback', () => {
  it('uses knee threshold for unimodal distributions', async () => {
    const deltas = buildUnimodalDeltas(240);
    const datasetKey = deriveDatasetKey('c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=');
    const sessionStartEpoch = Math.trunc(Date.parse('2024-01-01T00:00:00.000Z') / 1000);
    const sid = makeSid('user-1', sessionStartEpoch, algoVersion, datasetKey);
    const rows = deltas.map<SessionRow>((delta, index) => ({
      algo_ver: algoVersion,
      uid: 'user-1',
      generatedSessionId: sid,
      sessionSequence: 0,
      sessionIndex: index,
      timestampUtc: '2024-01-01T00:00:00.000Z',
      deltaSeconds: delta,
      idleTimeoutSeconds: 1800,
      splitReason: 'continuous',
      original: {}
    }));

    const thresholds = await estimateThresholdsByUser(rows, { minimumSamples: 5, fallbackPercentile: 0.95 });
    expect(thresholds.algo_ver).toBe(algoVersion);
    const actual = thresholds.get('user-1');
    expect(Number.isFinite(actual)).toBe(true);

    const logValues = deltas.map((value) => Math.log(value));
    const { bicDifference } = bimodalityTest(logValues);
    const histogram = makeLogHistogram(deltas);
    const { tauLog, quality } = otsuThreshold(histogram);
    const shouldUseKnee = bicDifference <= 0 || quality < 0.25;
    expect(shouldUseKnee).toBe(true);

    const sigmaLog = (() => {
      const mean = logValues.reduce((acc, value) => acc + value, 0) / logValues.length;
      const variance = logValues.reduce((acc, value) => acc + (value - mean) ** 2, 0) / logValues.length;
      return Math.sqrt(Math.max(0, variance));
    })();
    const expectedKnee = kneeThreshold(deltas, tauLog, sigmaLog);
    const expectedQuantile = percentile(deltas, 0.95);
    const expected = Math.max(expectedKnee, expectedQuantile);
    expect(Math.abs((actual ?? 0) - expected)).toBeLessThan(1e-6);
  });
});
