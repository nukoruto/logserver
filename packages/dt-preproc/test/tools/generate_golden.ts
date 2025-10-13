import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadLogRowsWithFeatures } from '../../src/index.js';

async function main(): Promise<void> {
  const fixturesDir = path.dirname(fileURLToPath(new URL('../fixtures/golden_input.csv', import.meta.url)));
  const inputPath = path.join(fixturesDir, 'golden_input.csv');
  const featuresPath = path.join(fixturesDir, 'golden_features.json');
  const metaPath = path.join(fixturesDir, 'golden_meta.json');

  const result = await loadLogRowsWithFeatures(inputPath, {
    clipMaxSeconds: 300,
    robustZClip: 5,
    minSamples: 2
  });

  const features = result.rows.map((row) => ({
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
  }));

  const meta = {
    parseStats: result.parseStats,
    featureStats: normalizeFeatureStats(result.featureStats),
    options: result.options
  };

  writeFileSync(featuresPath, `${JSON.stringify(features, null, 2)}\n`, 'utf8');
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
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

void main();
