import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { loadLogRowsWithFeatures, type LogRowWithFeats } from '../src/index.js';

function fixturePath(name: string): string {
  return path.join(path.dirname(fileURLToPath(new URL('./fixtures/golden_input.csv', import.meta.url))), name);
}

function normalizeRow(row: LogRowWithFeats) {
  return {
    timestamp_epoch_seconds: row.timestamp_epoch_seconds,
    uid: row.uid,
    session_id: row.session_id,
    row_index: row.row_index,
    delta_seconds: normalizeNumber(row.delta_seconds),
    delta_clipped_seconds: normalizeNumber(row.delta_clipped_seconds),
    delta_robust_z: normalizeNumber(row.delta_robust_z),
    delta_z_deseas_clipped: normalizeNumber(row.delta_z_deseas_clipped),
    delta_log_burst: normalizeNumber(row.delta_log_burst),
    delta_time_label: row.delta_time_label,
    session_sequence: row.session_sequence,
    session_elapsed_seconds: normalizeNumber(row.session_elapsed_seconds),
    is_session_start: row.is_session_start
  };
}

function normalizeNumber(value: number | null): number | null {
  if (value === null || Number.isNaN(value)) {
    return null;
  }
  return Math.round(value * 1e9) / 1e9;
}

function normalizeFeatureStats(stats: unknown) {
  if (typeof stats !== 'object' || stats === null) {
    return stats;
  }
  const cast = stats as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(cast)) {
    if (typeof raw === 'number') {
      result[key] = normalizeNumber(raw) ?? null;
    } else {
      result[key] = raw;
    }
  }
  return result;
}

test('loadLogRowsWithFeatures produces stable golden output', async () => {
  const input = fixturePath('golden_input.csv');
  const expectedRows = JSON.parse(readFileSync(fixturePath('golden_features.json'), 'utf8'));
  const expectedMeta = JSON.parse(readFileSync(fixturePath('golden_meta.json'), 'utf8'));

  const result = await loadLogRowsWithFeatures(input, {
    clipMaxSeconds: 300,
    robustZClip: 5,
    minSamples: 2
  });

  const actualRows = result.rows.map(normalizeRow);
  const actualMeta = {
    parseStats: result.parseStats,
    featureStats: normalizeFeatureStats(result.featureStats),
    options: result.options
  };

  try {
    expect(actualRows).toEqual(expectedRows);
  } catch (error) {
    throw new Error(`packages/dt-preproc/test/fixtures/golden_features.json mismatch: ${(error as Error).message}`);
  }

  try {
    expect(actualMeta).toEqual({
      parseStats: expectedMeta.parseStats,
      featureStats: expectedMeta.featureStats,
      options: expectedMeta.options
    });
  } catch (error) {
    throw new Error(`packages/dt-preproc/test/fixtures/golden_meta.json mismatch: ${(error as Error).message}`);
  }
});
