import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { collectSystemHealth } from '../src/python/runner.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

test('collectSystemHealth provides structured status', async () => {
  const report = await collectSystemHealth(repoRoot);
  assert.equal(typeof report.timestamp, 'string');
  assert.ok(Array.isArray(report.io.directories));
  assert.equal(report.io.directories.length, 3);
  for (const dir of report.io.directories) {
    assert.ok(typeof dir.path === 'string');
    assert.ok(typeof dir.exists === 'boolean');
    assert.ok(typeof dir.writable === 'boolean');
  }
  assert.ok(typeof report.disk.ok === 'boolean');
  assert.ok(typeof report.disk.thresholdBytes === 'number');
  assert.ok('freeBytes' in report.disk);
  assert.ok(Array.isArray(report.warnings));
  assert.ok(Array.isArray(report.errors));
  assert.ok(['ada6000', '4060', 'cpu', 'unknown'].includes(report.gpu.mode));
});
