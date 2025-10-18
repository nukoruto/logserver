import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { algoVersion, estimateThresholdsWithMeta } from '../dist/index.js';

type ShardRow = {
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

function makeRow(uid: string, delta: number | null, index: number): ShardRow {
  return {
    algo_ver: algoVersion,
    uid,
    generatedSessionId: `${uid}-session-0`,
    sessionSequence: 0,
    sessionIndex: index,
    timestampUtc: '2024-01-01T00:00:00Z',
    deltaSeconds: delta,
    idleTimeoutSeconds: 1800,
    splitReason: 'continuous',
    original: {}
  };
}

describe('shard cleanup', () => {
  it('removes temporary shards after estimation', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'session-shard-test-'));
  try {
    const rows: ShardRow[] = [];
    for (let i = 0; i < 3; i += 1) {
      const uid = `user-${i}`;
      for (let j = 0; j < 32; j += 1) {
        rows.push(makeRow(uid, 1 + j * 0.01, j));
      }
    }

    await estimateThresholdsWithMeta(rows, { shard_dir: baseDir, concurrency: 2 });
    const remaining = await readdir(baseDir);
      expect(remaining.length, 'shard directory should be empty after cleanup').toBe(0);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
  });
});
