import { test } from 'node:test';
import assert from 'node:assert/strict';

import { algoVersion, estimateThresholdsWithMeta } from '../dist/index.js';

function makeRow(uid, deltaSeconds, userAgentType, index = 0) {
  return {
    algo_ver: algoVersion,
    uid,
    generatedSessionId: `${uid}-session-0`,
    sessionSequence: 0,
    sessionIndex: index,
    timestampUtc: '2024-01-01T00:00:00Z',
    deltaSeconds,
    idleTimeoutSeconds: 1800,
    splitReason: 'continuous',
    original: { user_agent_type: userAgentType }
  };
}

test('hierarchical backoff provides stable thresholds for sparse users', () => {
  const rows = [];

  for (let i = 0; i < 100; i += 1) {
    rows.push(makeRow('rich-desktop', 5, 'desktop', i));
  }

  rows.push(makeRow('sparse-desktop', null, 'desktop', 0));
  rows.push(makeRow('sparse-desktop', 15, 'desktop', 1));
  rows.push(makeRow('sparse-desktop', 15, 'desktop', 2));

  rows.push(makeRow('solo-mobile', null, 'mobile', 0));
  rows.push(makeRow('solo-mobile', 30, 'mobile', 1));

  rows.push(makeRow('only-null', null, 'robot', 0));

  const result = estimateThresholdsWithMeta(rows, {
    minimumSamples: 1000,
    fallbackPercentile: 0.9,
    min_events: 50,
    backoff: true
  });

  const thresholds = result.thresholds;
  const details = result.perUser;

  const expected = 5;

  assert.equal(details.get('rich-desktop')?.backoff_level, 'user');
  assert.equal(details.get('sparse-desktop')?.backoff_level, 'group:user_agent_type=desktop');
  assert.equal(details.get('solo-mobile')?.backoff_level, 'global');
  assert.equal(details.get('only-null')?.backoff_level, 'global');

  assert.ok(Math.abs(thresholds.get('rich-desktop') - expected) < 1e-9);
  assert.ok(Math.abs(thresholds.get('sparse-desktop') - expected) < 1e-9);
  assert.ok(Math.abs(thresholds.get('solo-mobile') - expected) < 1e-9);
  assert.ok(Number.isFinite(thresholds.get('only-null')));

  const repeat = estimateThresholdsWithMeta(rows, {
    minimumSamples: 1000,
    fallbackPercentile: 0.9,
    min_events: 50,
    backoff: true
  });
  assert.deepEqual(Array.from(repeat.thresholds.entries()), Array.from(thresholds.entries()));
});
