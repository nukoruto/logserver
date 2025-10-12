import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { algoVersion, estimateThresholdsWithMeta } from '../dist/index.js';

function buildRows(userCount, perUser) {
  const rows = [];
  for (let i = 0; i < userCount; i += 1) {
    const uid = `bench-${i}`;
    for (let j = 0; j < perUser; j += 1) {
      rows.push({
        algo_ver: algoVersion,
        uid,
        generatedSessionId: `${uid}-session-0`,
        sessionSequence: 0,
        sessionIndex: j,
        timestampUtc: '2024-01-01T00:00:00.000Z',
        deltaSeconds: 1 + ((i + j) % 97) * 0.01,
        idleTimeoutSeconds: 1800,
        splitReason: 'continuous',
        original: {}
      });
    }
  }
  return rows;
}

test('worker concurrency reduces estimation wall time', async () => {
  const rows = buildRows(24, 256);
  const seqDir = await mkdtemp(path.join(os.tmpdir(), 'session-bench-seq-'));
  const parDir = await mkdtemp(path.join(os.tmpdir(), 'session-bench-par-'));
  try {
    const sequentialStart = performance.now();
    await estimateThresholdsWithMeta(rows, { concurrency: 1, shard_dir: seqDir });
    const sequentialDuration = performance.now() - sequentialStart;

    const maxWorkers = Math.min(4, Math.max(1, os.cpus().length));
    const parallelStart = performance.now();
    await estimateThresholdsWithMeta(rows, { concurrency: maxWorkers, shard_dir: parDir });
    const parallelDuration = performance.now() - parallelStart;

    const tolerance = sequentialDuration * 0.5 + 50;
    assert.ok(
      parallelDuration <= sequentialDuration + tolerance,
      `parallel execution should not exceed sequential duration by more than ${tolerance.toFixed(2)}ms (seq=${sequentialDuration.toFixed(2)}ms, par=${parallelDuration.toFixed(2)}ms)`
    );
  } finally {
    await rm(seqDir, { recursive: true, force: true });
    await rm(parDir, { recursive: true, force: true });
  }
});
