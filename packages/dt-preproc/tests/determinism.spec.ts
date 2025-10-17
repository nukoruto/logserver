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

function appendSession(
  rows: LogRow[],
  uid: string,
  sessionId: string,
  startSeconds: number,
  deltas: readonly number[],
  startIndex: number
): number {
  let current = startSeconds;
  let index = startIndex;
  for (const delta of deltas) {
    rows.push(createRow(uid, sessionId, current, index));
    current += delta;
    index += 1;
  }
  return index;
}

describe('StreamingFeatureTransformer determinism', () => {
  it('produces identical feature rows for identical fitted stats', () => {
    const rows: LogRow[] = [];
    let index = 0;
    index = appendSession(rows, 'userDet', 'sessA', 1_000, [2, 5, 1, 9], index);
    appendSession(rows, 'userDet', 'sessB', 5_000, [3, 2, 4, 6], index);

    const fitted = fitRobustStats(rows, { epsilon_t: 0.05, grouping: 'uid_session', min_samples: 1 });
    const options = {
      epsilon: fitted.epsilon,
      epsilonT: 0.05,
      clipMaxSeconds: 300,
      robustZClip: 5,
      minSamples: 1
    } as const;

    const transformerA = new StreamingFeatureTransformer({ fitted, grouping: 'uid_session', ...options });
    const firstPass = rows.map((row) => transformerA.process({ ...row }));

    const transformerB = new StreamingFeatureTransformer({ fitted, grouping: 'uid_session', ...options });
    const secondPass = rows.map((row) => transformerB.process({ ...row }));

    expect(secondPass.length).toBe(firstPass.length);
    for (let i = 0; i < firstPass.length; i += 1) {
      expect(secondPass[i]).toStrictEqual(firstPass[i]);
      const values = Object.values(secondPass[i]);
      for (const value of values) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }

    expect(transformerB.getStats()).toStrictEqual(transformerA.getStats());
  });
});
