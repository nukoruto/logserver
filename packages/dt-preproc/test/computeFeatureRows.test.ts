import { expect, test } from 'vitest';

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

  expect(featureRows).toHaveLength(rows.length);

  expect(featureRows[0].delta_log_burst).toBeNull();
  expect(featureRows[1].delta_log_burst).toBeNull();

  const expected = Math.log((10 + 0.0005) / (5 + 0.0005));
  expect(featureRows[2].delta_log_burst).not.toBeNull();
  expect(Math.abs(featureRows[2].delta_log_burst! - expected)).toBeLessThan(1e-6);

  expect(featureRows[3].delta_time_label).toBe('unknown');
  expect(featureRows[3].delta_log_burst).toBeNull();

  expect(featureRows[4].delta_time_label).toBe('measured');
  expect(featureRows[4].delta_log_burst).toBeNull();

  expect(featureRows[5].session_id).toBe('session-b');
  expect(featureRows[5].delta_log_burst).toBeNull();
  expect(featureRows[6].session_id).toBe('session-b');
  expect(featureRows[6].delta_log_burst).toBeNull();
});
