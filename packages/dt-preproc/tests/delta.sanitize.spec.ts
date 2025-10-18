import { describe, expect, it } from 'vitest';

import {
  StreamingFeatureTransformer,
  fitRobustStats,
  type LogRow
} from '../src/index.js';

function createRow(uid: string, sessionId: string, epochSeconds: number, index: number): LogRow {
  return {
    timestamp_utc: new Date(epochSeconds * 1000).toISOString(),
    timestamp_epoch_seconds: epochSeconds,
    uid,
    session_id: sessionId,
    method: 'GET',
    path: '/resource',
    referer: '',
    user_agent: 'test-agent',
    ip: '127.0.0.1',
    op_category: 'READ',
    row_index: index
  };
}

describe('StreamingFeatureTransformer delta sanitisation', () => {
  it('never emits Δt below the fitted epsilon', () => {
    const rows: LogRow[] = [];
    const start = 1_700_000_000;
    rows.push(createRow('user-zero', 'sess-zero', start, 0));
    rows.push(createRow('user-zero', 'sess-zero', start, 1));
    rows.push(createRow('user-zero', 'sess-zero', start + 0.5, 2));
    rows.push(createRow('user-zero', 'sess-zero', start + 1.3, 3));

    const fitted = fitRobustStats(rows, { epsilon_t: 0.05, grouping: 'uid_session', min_samples: 1 });
    const epsilon = fitted.epsilon;
    expect(epsilon).toBeGreaterThan(0);

    const transformer = new StreamingFeatureTransformer({
      fitted,
      grouping: 'uid_session',
      epsilon,
      epsilonT: 0.05,
      clipMaxSeconds: 300,
      robustZClip: 5,
      minSamples: 1
    });

    const processed = rows.map((row) => transformer.process({ ...row }));

    const options = transformer.getOptions();
    expect(options.epsilon).toBeGreaterThan(0);

    const deltaValues = processed
      .map((row) => row.delta_clipped_seconds)
      .filter((value): value is number => value !== null);

    expect(deltaValues.length).toBeGreaterThan(0);
    for (const value of deltaValues) {
      expect(value).toBeGreaterThanOrEqual(options.epsilon);
    }

    const second = processed[1];
    expect(second.delta_seconds).toBeCloseTo(options.epsilon, 12);
    expect(second.delta_clipped_seconds).toBeCloseTo(options.epsilon, 12);

    const stats = transformer.getStats();
    expect(stats.measured + stats.unknown + stats.initial).toBe(stats.total);
  });
});
