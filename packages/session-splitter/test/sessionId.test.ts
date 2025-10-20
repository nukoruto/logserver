import { describe, expect, it } from 'vitest';

import { makeSid, deriveDatasetKey, algoVersion } from '../dist/index.js';

const FIXTURE_JWT_KEY = 'c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=';

function epochSeconds(timestampUtc: string): number {
  return Math.trunc(Date.parse(timestampUtc) / 1000);
}

describe('makeSid', () => {
  it('is deterministic for identical inputs', () => {
  const datasetKey = deriveDatasetKey(FIXTURE_JWT_KEY);
  const epoch = epochSeconds('2024-05-01T12:34:56.000Z');
  const sidA = makeSid('user-123', epoch, algoVersion, datasetKey);
  const sidB = makeSid('user-123', epoch, algoVersion, datasetKey);
    expect(sidA).toBe(sidB);
  });

  it('changes when any component differs', () => {
  const datasetKey = deriveDatasetKey(FIXTURE_JWT_KEY);
  const epoch = epochSeconds('2024-05-01T12:34:56.000Z');
  const base = makeSid('user-123', epoch, algoVersion, datasetKey);

  const diffUser = makeSid('user-456', epoch, algoVersion, datasetKey);
    expect(diffUser).not.toBe(base);

  const diffEpoch = makeSid('user-123', epoch + 1, algoVersion, datasetKey);
    expect(diffEpoch).not.toBe(base);

  const diffAlgo = makeSid('user-123', epoch, `${algoVersion}-alt`, datasetKey);
    expect(diffAlgo).not.toBe(base);

  const otherDatasetKey = deriveDatasetKey('c2VlZF9rZXlfZm9yX3NpZF9kZXJpdmF0aW9uXzEyMzQ1Ng==');
  const diffKey = makeSid('user-123', epoch, algoVersion, otherDatasetKey);
    expect(diffKey).not.toBe(base);
  });
});
