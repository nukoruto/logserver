import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeSid, deriveDatasetKey, algoVersion } from '../dist/index.js';

const FIXTURE_JWT_KEY = 'c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=';

function epochSeconds(timestampUtc: string): number {
  return Math.trunc(Date.parse(timestampUtc) / 1000);
}

test('makeSid is deterministic for identical inputs', () => {
  const datasetKey = deriveDatasetKey(FIXTURE_JWT_KEY);
  const epoch = epochSeconds('2024-05-01T12:34:56.000Z');
  const sidA = makeSid('user-123', epoch, algoVersion, datasetKey);
  const sidB = makeSid('user-123', epoch, algoVersion, datasetKey);
  assert.equal(sidA, sidB);
});

test('makeSid changes when any component differs', () => {
  const datasetKey = deriveDatasetKey(FIXTURE_JWT_KEY);
  const epoch = epochSeconds('2024-05-01T12:34:56.000Z');
  const base = makeSid('user-123', epoch, algoVersion, datasetKey);

  const diffUser = makeSid('user-456', epoch, algoVersion, datasetKey);
  assert.notEqual(base, diffUser);

  const diffEpoch = makeSid('user-123', epoch + 1, algoVersion, datasetKey);
  assert.notEqual(base, diffEpoch);

  const diffAlgo = makeSid('user-123', epoch, `${algoVersion}-alt`, datasetKey);
  assert.notEqual(base, diffAlgo);

  const otherDatasetKey = deriveDatasetKey('c2VlZF9rZXlfZm9yX3NpZF9kZXJpdmF0aW9uXzEyMzQ1Ng==');
  const diffKey = makeSid('user-123', epoch, algoVersion, otherDatasetKey);
  assert.notEqual(base, diffKey);
});
