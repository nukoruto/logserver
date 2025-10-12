import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeFeatureRows, type LogRow } from '../src/index.js';

const baseSeconds = 1_720_000_000;

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function makeRow(
  session: string,
  timestamp: number,
  rowIndex: number
): LogRow {
  return {
    timestamp_utc: isoFromSeconds(timestamp),
    timestamp_epoch_seconds: timestamp,
    uid: 'user-1',
    session_id: session,
    method: 'GET',
    path: '/resource',
    referer: '',
    user_agent: 'tester',
    ip: '127.0.0.1',
    op_category: 'READ',
    row_index: rowIndex
  };
}

test('computeFeatureRows annotates symmetric log burst for consecutive measured Δt', () => {
  const rows: LogRow[] = [
    makeRow('session-a', baseSeconds, 0),
    makeRow('session-a', baseSeconds + 10, 1),
    makeRow('session-a', baseSeconds + 15, 2),
    makeRow('session-a', baseSeconds + 15.01, 3),
    makeRow('session-a', baseSeconds + 25.01, 4),
    makeRow('session-b', baseSeconds + 40, 5),
    makeRow('session-b', baseSeconds + 50, 6)
  ];

  const { rows: featureRows } = computeFeatureRows(rows, {
    epsilon: 0.0005,
    epsilonT: 0.05,
    clipMaxSeconds: 300
  });

  assert.equal(featureRows.length, rows.length);

  assert.equal(featureRows[0].delta_log_burst, null);
  assert.equal(featureRows[1].delta_log_burst, null);

  const expected = Math.log((10 + 0.0005) / (5 + 0.0005));
  assert.ok(featureRows[2].delta_log_burst !== null);
  assert.ok(Math.abs(featureRows[2].delta_log_burst! - expected) < 1e-6);

  assert.equal(featureRows[3].delta_time_label, 'unknown');
  assert.equal(featureRows[3].delta_log_burst, null);

  assert.equal(featureRows[4].delta_time_label, 'measured');
  assert.equal(featureRows[4].delta_log_burst, null);

  assert.equal(featureRows[5].session_id, 'session-b');
  assert.equal(featureRows[5].delta_log_burst, null);
  assert.equal(featureRows[6].session_id, 'session-b');
  assert.equal(featureRows[6].delta_log_burst, null);
});
