import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDeltas,
  type DeltaComputationResult,
  type DeltaAnnotatedRow
} from '../src/index.js';

interface TestRow {
  uid: string;
  timestamp_epoch_seconds: number;
  timestamp_utc: string;
  id: string;
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

const baseSeconds = 1722528896;

const SAMPLE_ROWS: TestRow[] = [
  {
    uid: 'user-a',
    timestamp_epoch_seconds: baseSeconds,
    timestamp_utc: isoFromSeconds(baseSeconds),
    id: 'initial'
  },
  {
    uid: 'user-a',
    timestamp_epoch_seconds: baseSeconds + 0.0004,
    timestamp_utc: isoFromSeconds(baseSeconds + 0.0004),
    id: 'epsilon-noise'
  },
  {
    uid: 'user-a',
    timestamp_epoch_seconds: baseSeconds + 0.0504,
    timestamp_utc: isoFromSeconds(baseSeconds + 0.0504),
    id: 'fifty-ms'
  },
  {
    uid: 'user-a',
    timestamp_epoch_seconds: baseSeconds + 0.2004,
    timestamp_utc: isoFromSeconds(baseSeconds + 0.2004),
    id: 'long-gap'
  }
];

test('computeDeltas labels unknown region using epsilon thresholds', () => {
  const result: DeltaComputationResult<TestRow> = computeDeltas(SAMPLE_ROWS, {
    epsilon: 0.0005,
    epsilon_t: 0.001
  });

  const annotatedIds = result.rows.map((item: DeltaAnnotatedRow<TestRow>) => item.row.id);
  assert.deepEqual(annotatedIds, ['initial', 'epsilon-noise', 'fifty-ms', 'long-gap']);

  assert.equal(result.rows[0].timeLabel, 'initial');
  assert.equal(result.rows[1].deltaSeconds, 0);
  assert.equal(result.rows[1].timeLabel, 'unknown');
  assert.equal(result.rows[2].timeLabel, 'measured');
  assert.ok(result.rows[2].deltaSeconds && result.rows[2].deltaSeconds > 0.001);
  assert.equal(result.rows[3].timeLabel, 'measured');

  assert.equal(result.stats.total, SAMPLE_ROWS.length);
  assert.equal(result.stats.initial, 1);
  assert.equal(result.stats.unknown, 1);
  assert.equal(result.stats.measured, 2);
});

test('unknown share increases when epsilon_t grows with large NTP offset', () => {
  const lowUncertainty = computeDeltas(SAMPLE_ROWS, {
    epsilon: 0.0005,
    epsilon_t: 0.001
  });

  const highUncertainty = computeDeltas(SAMPLE_ROWS, {
    epsilon: 0.0005,
    epsilon_t: 0.05
  });

  assert.equal(lowUncertainty.stats.total, SAMPLE_ROWS.length);
  assert.equal(highUncertainty.stats.total, SAMPLE_ROWS.length);
  assert.ok(highUncertainty.stats.unknown > lowUncertainty.stats.unknown);
});
