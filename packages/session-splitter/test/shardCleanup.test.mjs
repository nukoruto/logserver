import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { algoVersion, estimateThresholdsWithMeta } from '../dist/index.js';

function makeRow(uid, delta, index) {
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

test('temporary shards are removed after estimation', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'session-shard-test-'));
  try {
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      const uid = `user-${i}`;
      for (let j = 0; j < 32; j += 1) {
        rows.push(makeRow(uid, 1 + j * 0.01, j));
      }
    }

    await estimateThresholdsWithMeta(rows, { shard_dir: baseDir, concurrency: 2 });
    const remaining = await readdir(baseDir);
    assert.equal(remaining.length, 0, 'shard directory should be empty after cleanup');
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
