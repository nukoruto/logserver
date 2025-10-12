'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const configModule = require('../../config');
const config = configModule.default || configModule;
const { labelSequence } = require('../labeler');

const CSV_HEADER =
  'timestamp,session_id,user_id,event,method,path,status,latency_ms,delta_t,metadata,dt_sec,log_dt,z,z_clipped,time_label,sid_final';

const EXTRA_COLUMN_NAMES = ['dt_sec', 'log_dt', 'z', 'z_clipped', 'time_label'];

const hasOwn = Object.prototype.hasOwnProperty;

const clamp = (value, min, max) => {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
};

const sanitizeNumeric = (value) => {
  if (typeof value !== 'number') {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
};

const computeMeanAndStd = (values) => {
  if (!Array.isArray(values) || values.length === 0) {
    return { mean: 0, std: 0 };
  }
  const count = values.length;
  const sum = values.reduce((acc, value) => acc + value, 0);
  const mean = sum / count;
  const variance =
    values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / count;
  const std = Number.isFinite(variance) && variance > 0 ? Math.sqrt(variance) : 0;
  return { mean, std };
};

const normalizeLabel = (value) => {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed === 'ok' ? 'ok' : 'unknown';
};

const extrasResolvers = {
  dt_sec: null,
  log_dt: null,
  z: null,
  z_clipped: null,
  time_label: null,
};

const augmentRows = (rows, extras = {}) => {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const resolvers = { ...extrasResolvers };
  for (const column of EXTRA_COLUMN_NAMES) {
    const resolver = extras[column];
    if (resolver !== undefined && typeof resolver !== 'function') {
      throw new TypeError(`${column} override must be a function when provided`);
    }
    resolvers[column] = resolver ?? null;
  }

  const sanitizedRows = rows.map((event) =>
    event && typeof event === 'object' ? { ...event } : {}
  );

  const dtValues = sanitizedRows.map((event, index) => {
    const fallback = sanitizeNumeric(extractDeltaSeconds(event));
    const resolved = resolvers.dt_sec
      ? sanitizeNumeric(resolvers.dt_sec(event, index, sanitizedRows, fallback))
      : fallback;
    return resolved !== null && resolved > 0 ? resolved : null;
  });

  const positiveDtValues = dtValues.filter((value) => value !== null);
  const { mean, std } = computeMeanAndStd(positiveDtValues);

  return sanitizedRows.map((event, index) => {
    const dtSec = dtValues[index];
    const logFallback = dtSec !== null && dtSec > 0 ? Math.log(dtSec) : null;
    const logDt = resolvers.log_dt
      ? sanitizeNumeric(resolvers.log_dt(event, index, sanitizedRows, logFallback)) ?? logFallback
      : logFallback;

    let zScore = null;
    if (dtSec !== null) {
      zScore = std > 0 ? (dtSec - mean) / std : 0;
    }
    if (resolvers.z) {
      const override = resolvers.z(event, index, sanitizedRows, zScore);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        zScore = numeric;
      }
    }

    const clippedFallback = zScore === null ? null : clamp(zScore, -5, 5);
    const zClipped = resolvers.z_clipped
      ? sanitizeNumeric(
          resolvers.z_clipped(event, index, sanitizedRows, clippedFallback)
        ) ?? clippedFallback
      : clippedFallback;

    const labelFallback = dtSec === null ? 'unknown' : 'ok';
    const labelOverride = resolvers.time_label
      ? resolvers.time_label(event, index, sanitizedRows, labelFallback)
      : null;
    const timeLabel = labelOverride
      ? normalizeLabel(labelOverride)
      : normalizeLabel(labelFallback);

    return {
      ...event,
      dt_sec: dtSec,
      log_dt: logDt,
      z: zScore,
      z_clipped: zClipped,
      time_label: timeLabel,
    };
  });
};

const toCsvField = (value) => {
  if (value === undefined || value === null) {
    return '""';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `"${value}"`;
  }
  if (typeof value === 'string') {
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  const serialized = JSON.stringify(value);
  const escaped = serialized.replace(/"/g, '""');
  return `"${escaped}"`;
};

const sanitizeRunId = (runId) => {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return null;
  }
  const trimmed = runId.trim();
  return trimmed.replace(/[^a-zA-Z0-9_-]+/g, '-');
};

const generateRunId = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `sim-${timestamp}`;
};

const ensureDirectory = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const extractDeltaSeconds = (event) => {
  const candidates = [
    event.deltaSeconds,
    event.delta_seconds,
    event.delta_t,
    event.deltaT,
    event.delta,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
};

const summarizeDeltas = (events) => {
  const deltas = events
    .map((event) => extractDeltaSeconds(event))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);

  if (deltas.length === 0) {
    return {
      count: 0,
      mean: null,
      median: null,
      stddev: null,
      min: null,
      max: null,
    };
  }

  const sum = deltas.reduce((acc, value) => acc + value, 0);
  const mean = sum / deltas.length;
  const variance =
    deltas.reduce((acc, value) => acc + (value - mean) ** 2, 0) / deltas.length;
  const stddev = Math.sqrt(variance);
  const middle = Math.floor(deltas.length / 2);
  const median =
    deltas.length % 2 === 0
      ? (deltas[middle - 1] + deltas[middle]) / 2
      : deltas[middle];

  return {
    count: deltas.length,
    mean,
    median,
    stddev,
    min: deltas[0],
    max: deltas[deltas.length - 1],
  };
};

const buildAnomalySummary = (events) => {
  const summary = {};
  for (const event of events) {
    const label = typeof event.anomaly_type === 'string' ? event.anomaly_type : 'unknown';
    summary[label] = (summary[label] || 0) + 1;
  }
  return summary;
};

const computeSessionStats = (events) => {
  const sessionCounts = new Map();
  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue;
    }
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null;
    if (!sessionId) {
      continue;
    }
    sessionCounts.set(sessionId, (sessionCounts.get(sessionId) || 0) + 1);
  }
  return {
    totalSessions: sessionCounts.size,
    perSession: Object.fromEntries(sessionCounts.entries()),
  };
};

const serializeMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  if (Array.isArray(metadata)) {
    return { value: metadata };
  }
  return metadata;
};

const resolveSidFinal = (event) => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  if (hasOwn.call(event, 'sid_final')) {
    const explicit = event.sid_final;
    if (explicit !== undefined && explicit !== null && explicit !== '') {
      return explicit;
    }
  }
  const candidate = event.session_id;
  if (candidate === undefined || candidate === null || candidate === '') {
    return candidate ?? null;
  }
  return candidate;
};

const formatCsvAugmented = (event) => {
  const safeEvent = event && typeof event === 'object' ? event : {};
  const metadata = serializeMetadata(safeEvent.metadata);
  const sidFinal = resolveSidFinal(safeEvent);
  const row = [
    safeEvent.timestamp,
    safeEvent.session_id,
    safeEvent.user_id,
    safeEvent.event,
    safeEvent.method,
    safeEvent.path,
    safeEvent.status,
    safeEvent.latency_ms,
    extractDeltaSeconds(safeEvent),
    metadata,
    safeEvent.dt_sec,
    safeEvent.log_dt,
    safeEvent.z,
    safeEvent.z_clipped,
    safeEvent.time_label,
    sidFinal,
  ].map(toCsvField);
  return row.join(',');
};

const formatCsvRows = (events, extras) => {
  const augmented = augmentRows(events, extras);
  const rows = [CSV_HEADER];
  for (const event of augmented) {
    rows.push(formatCsvAugmented(event));
  }
  return rows.join('\n').concat('\n');
};

const defaultManifest = (overrides = {}) => ({
  scenario_id: overrides.scenario_id ?? null,
  generated_at: overrides.generated_at ?? new Date().toISOString(),
  seed: overrides.seed ?? null,
  transition_table_version: overrides.transition_table_version ?? null,
  run_id: overrides.run_id ?? generateRunId(),
  parameters: overrides.parameters ?? {},
  tags: overrides.tags ?? [],
  notes: overrides.notes ?? null,
});

const persistSimulationRun = async (input) => {
  const events = Array.isArray(input?.events) ? input.events : [];
  if (events.length === 0) {
    throw new Error('persistSimulationRun requires a non-empty events array');
  }

  const labeled = labelSequence(events);
  const runId = sanitizeRunId(input?.runId) || generateRunId();
  const generatedAt = new Date().toISOString();
  const outputDir = input?.outputDir ? path.resolve(input.outputDir) : config.simLogRoot;

  await ensureDirectory(outputDir);

  const csvFileName = input?.csvFileName || `simEvents-${runId}.csv`;
  const manifestFileName = input?.manifestFileName || `scenario-${runId}.json`;
  const csvPath = path.join(outputDir, csvFileName);
  const manifestPath = path.join(outputDir, manifestFileName);

  const csvContent = formatCsvRows(labeled, input?.featureOverrides);
  await fs.writeFile(csvPath, csvContent, { encoding: 'utf8' });

  const hash = crypto.createHash('sha256').update(csvContent, 'utf8').digest('hex');
  const sessionStats = computeSessionStats(labeled);
  const deltaStats = summarizeDeltas(labeled);
  const anomalySummary = buildAnomalySummary(labeled);
  const totalAnomalies = Object.entries(anomalySummary)
    .filter(([label]) => label !== 'normal')
    .reduce((acc, [, count]) => acc + count, 0);

  const manifest = {
    ...defaultManifest({
      scenario_id: input?.scenarioId ?? input?.manifest?.scenario_id,
      generated_at: generatedAt,
      seed: input?.seed ?? input?.manifest?.seed,
      transition_table_version:
        input?.transitionTableVersion ?? input?.manifest?.transition_table_version ?? null,
      run_id: runId,
      parameters: input?.parameters ?? input?.manifest?.parameters ?? {},
      tags: input?.tags ?? input?.manifest?.tags ?? [],
      notes: input?.notes ?? input?.manifest?.notes ?? null,
    }),
    counts: {
      events: labeled.length,
      sessions: sessionStats.totalSessions,
      anomalies: totalAnomalies,
    },
    anomaly_summary: anomalySummary,
    delta_seconds: deltaStats,
    session_event_counts: sessionStats.perSession,
    output: {
      csv_path: csvPath,
      manifest_path: manifestPath,
      csv_sha256: hash,
    },
    source: {
      sim_log_dir: outputDir,
    },
  };

  if (Array.isArray(input?.sessionIds) && input.sessionIds.length > 0) {
    manifest.session_ids = Array.from(new Set(input.sessionIds));
  } else {
    const derivedSessions = Object.keys(sessionStats.perSession);
    if (derivedSessions.length > 0) {
      manifest.session_ids = derivedSessions;
    }
  }

  if (input?.transitionTableVersion) {
    manifest.transition_table_version = input.transitionTableVersion;
  }

  if (input?.extraMetadata && typeof input.extraMetadata === 'object') {
    manifest.extra = { ...input.extraMetadata };
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
  });

  return {
    csvPath,
    manifestPath,
    runId,
    events: labeled,
    manifest,
    hash,
  };
};

module.exports = {
  persistSimulationRun,
  summarizeDeltas,
  buildAnomalySummary,
  augmentRows,
  formatCsvAugmented,
};
