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

  for (const row of featureRows) {
    if (row.delta_seconds !== null) {
      expect(row.delta_seconds).toBeGreaterThan(0);
    }
    if (row.delta_clipped_seconds !== null) {
      expect(row.delta_clipped_seconds).toBeGreaterThan(0);
    }
  }
});

test('computeFeatureRows emits causal rolling quantiles without NaN', () => {
  const rows: LogRow[] = [
    makeRow('session-c', baseSeconds, 0),
    makeRow('session-c', baseSeconds + 10, 1),
    makeRow('session-c', baseSeconds + 25, 2),
    makeRow('session-c', baseSeconds + 55, 3),
    makeRow('session-c', baseSeconds + 90, 4)
  ];

  const { rows: featureRows, options } = computeFeatureRows(rows, {
    epsilon: 0.0005,
    epsilonT: 0.05,
    clipMaxSeconds: 300,
    quantileWindow: 2,
    quantiles: [0.25, 0.5, 0.75]
  });

  expect(options.quantileFields.map((field) => field.field)).toEqual([
    'delta_quantile_0_25',
    'delta_quantile_0_5',
    'delta_quantile_0_75'
  ]);

  expect(featureRows[0].delta_m25).toBeNull();
  expect(featureRows[1].delta_m25).toBeNull();
  expect(featureRows[1].delta_m50).toBeNull();
  expect(featureRows[1].delta_m75).toBeNull();

  expect(featureRows[2].delta_m25).toBeCloseTo(10, 5);
  expect(featureRows[2].delta_m50).toBeCloseTo(10, 5);
  expect(featureRows[2].delta_m75).toBeCloseTo(10, 5);

  expect(featureRows[3].delta_quantiles?.delta_quantile_0_25).toBeCloseTo(11.25, 5);
  expect(featureRows[3].delta_quantiles?.delta_quantile_0_5).toBeCloseTo(12.5, 5);
  expect(featureRows[3].delta_quantiles?.delta_quantile_0_75).toBeCloseTo(13.75, 5);

  expect(featureRows[4].delta_m25).toBeCloseTo(18.75, 5);
  expect(featureRows[4].delta_m50).toBeCloseTo(22.5, 5);
  expect(featureRows[4].delta_m75).toBeCloseTo(26.25, 5);

  const quantileValues = featureRows[4].delta_quantiles ?? {};
  for (const value of Object.values(quantileValues)) {
    if (value !== null) {
      expect(Number.isNaN(value)).toBe(false);
    }
  }
});
