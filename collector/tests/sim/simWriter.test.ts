import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  persistSimulationRun,
  summarizeDeltas,
  augmentRows,
  formatCsvAugmented,
  DEFAULT_FEATURE_AUGMENTER,
} from '../../src/sim/persistence/simWriter';
import { CLIPPING_EVENTS, makeEventCopies } from './persistence/fixtures';

const DEFAULT_FEATURE_COLUMNS = [
  'dt_sec',
  'log_dt',
  'z',
  'z_clipped',
  'z_robust',
  'z_robust_clipped',
  'z_hourly',
  'z_hourly_clipped',
  'time_label',
  'log_burst_mean',
  'log_burst_std',
  'log_burst_z',
  'log_burst_z_clipped',
  ...DEFAULT_FEATURE_AUGMENTER.quantiles.map((quantile) => {
    const percent = (quantile * 100).toFixed(2).replace(/\.0+$/, '').replace('.', 'p');
    return `m_q${percent}`;
  }),
];

const CSV_BASE_COLUMNS = [
  'timestamp_utc',
  'session_id',
  'user_id',
  'event',
  'method',
  'path',
  'status',
  'latency_ms',
  'delta_t',
  'metadata',
];

const CSV_TRAILING_COLUMN = 'sid_final';

const parseCsvRow = (row: string): string[] => {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === '"') {
      const next = row[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
};

describe('simWriter.persistSimulationRun', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-writer-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('CSV とマニフェストを生成し、異常サマリと Δt 統計を格納する', async () => {
    const events = [
      {
        timestamp: '2024-05-01T00:00:01.000Z',
        timestamp_utc: '2024-05-01T00:00:01.000Z',
        session_id: 'sess-001',
        user_id: 'user-001',
        event: 'login',
        method: 'POST' as const,
        path: '/auth/login',
        status: 200,
        latency_ms: 120,
        deltaSeconds: 1.5,
        metadata: { op_category: 'AUTH', timezone_offset_seconds: 0 },
      },
      {
        timestamp: '2024-05-01T00:00:05.000Z',
        timestamp_utc: '2024-05-01T00:00:05.000Z',
        session_id: 'sess-001',
        user_id: 'user-001',
        event: 'delete',
        method: 'DELETE' as const,
        path: '/projects/alpha',
        status: 403,
        latency_ms: 210,
        deltaSeconds: 3.5,
        protocolViolationFlag: true,
        protocolViolationReasons: ['disallowedTransition'],
      },
      {
        timestamp: '2024-05-01T00:00:09.000Z',
        timestamp_utc: '2024-05-01T00:00:09.000Z',
        session_id: 'sess-099',
        sid_final: 'explicit-sid-099',
        user_id: 'user-314',
        event: 'browse',
        method: 'GET' as const,
        path: '/reports/daily',
        status: 200,
        latency_ms: 90,
        deltaSeconds: 4.0,
        timeDeviationFlag: true,
      },
    ];

    const result = await persistSimulationRun({
      events,
      scenarioId: 'default-flow',
      seed: 'unit-seed',
      transitionTableVersion: 'v2024-05-01',
      parameters: { maxSteps: 64 },
      runId: 'unit:test/001',
      outputDir: tempDir,
      tags: ['unit', 'simulation'],
      notes: 'unit test manifest verification',
    });

    expect(result.runId).toBe('unit-test-001');
    expect(path.basename(result.csvPath)).toBe('simEvents-unit-test-001.csv');
    expect(path.basename(result.manifestPath)).toBe('scenario-unit-test-001.json');

    const csvContent = await fs.readFile(result.csvPath, 'utf8');
    const rows = csvContent.trim().split('\n');
    const header = rows[0].split(',');
    expect(header).toEqual([...CSV_BASE_COLUMNS, ...DEFAULT_FEATURE_COLUMNS, CSV_TRAILING_COLUMN]);
    expect(header).not.toContain('timestamp');
    expect(rows).toHaveLength(events.length + 1);

    const headerIndex = new Map<string, number>();
    header.forEach((name, index) => headerIndex.set(name, index));
    const valueAt = (columns: string[], name: string): string => {
      const position = headerIndex.get(name);
      if (position === undefined) {
        throw new Error(`Column ${name} not found in header`);
      }
      return columns[position] ?? '';
    };

    const parsedRows = rows.slice(1).map(parseCsvRow);
    const timestampUtcValues = parsedRows.map((columns: string[]) => {
      const raw = valueAt(columns, 'timestamp_utc');
      return raw.replace(/^"/, '').replace(/"$/, '').replace(/""/g, '"');
    });
    expect(timestampUtcValues.every((value) => typeof value === 'string' && value.endsWith('Z'))).toBe(true);
    const metadataRows = parsedRows.map((columns: string[]) => JSON.parse(valueAt(columns, 'metadata') || '{}'));
    expect(metadataRows[0].anomaly).toBe('normal');
    expect(metadataRows[1].anomaly).toBe('protocol_violation');
    expect(metadataRows[2].anomaly).toBe('time_deviation');

    const dtValues = parsedRows.map((columns: string[]) => valueAt(columns, 'dt_sec'));
    expect(dtValues).toEqual(['', '3.5', '']);

    const logDtValues = parsedRows.map((columns: string[]) => valueAt(columns, 'log_dt'));
    expect(logDtValues[0]).toBe('');
    expect(Number(logDtValues[1])).toBeCloseTo(Math.log(3.5), 6);
    expect(logDtValues[2]).toBe('');

    const zValues = parsedRows.map((columns: string[]) => valueAt(columns, 'z'));
    expect(zValues).toEqual(['', '0', '']);

    const clippedValues = parsedRows.map((columns: string[]) => valueAt(columns, 'z_clipped'));
    expect(clippedValues).toEqual(['', '0', '']);

    const robustValues = parsedRows.map((columns: string[]) => valueAt(columns, 'z_robust'));
    expect(robustValues).toEqual(['', '0', '']);

    const hourlyValues = parsedRows.map((columns: string[]) => valueAt(columns, 'z_hourly'));
    expect(hourlyValues).toEqual(['', '0', '']);

    const logBurstMeanValues = parsedRows.map((columns: string[]) => valueAt(columns, 'log_burst_mean'));
    expect(logBurstMeanValues[0]).toBe('');
    expect(Number(logBurstMeanValues[1])).toBeCloseTo(Math.log(3.5), 6);
    expect(Number(logBurstMeanValues[2])).toBeCloseTo(Math.log(3.5), 6);

    const logBurstStdValues = parsedRows.map((columns: string[]) => valueAt(columns, 'log_burst_std'));
    expect(logBurstStdValues).toEqual(['', '0', '0']);

    const quantile25Values = parsedRows.map((columns: string[]) => valueAt(columns, 'm_q25'));
    expect(quantile25Values).toEqual(['', '3.5', '3.5']);

    const quantile75Values = parsedRows.map((columns: string[]) => valueAt(columns, 'm_q75'));
    expect(quantile75Values).toEqual(['', '3.5', '3.5']);

    const labelValues = parsedRows.map((columns: string[]) => valueAt(columns, 'time_label'));
    expect(labelValues).toEqual(['initial', 'measured', 'initial']);

    const sidFinalValues = parsedRows.map((columns: string[]) => valueAt(columns, CSV_TRAILING_COLUMN));
    expect(sidFinalValues).toEqual(['sess-001', 'sess-001', 'explicit-sid-099']);

    const manifestRaw = await fs.readFile(result.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);

    expect(manifest.scenario_id).toBe('default-flow');
    expect(manifest.seed).toBe('unit-seed');
    expect(manifest.transition_table_version).toBe('v2024-05-01');
    expect(manifest.parameters).toEqual({ maxSteps: 64 });
    expect(manifest.tags).toEqual(['unit', 'simulation']);
    expect(manifest.notes).toBe('unit test manifest verification');
    expect(manifest.counts).toEqual({ events: 3, sessions: 2, anomalies: 2 });
    expect(manifest.anomaly_summary).toEqual({ normal: 1, protocol_violation: 1, time_deviation: 1 });
    expect(manifest.session_event_counts).toEqual({ 'sess-001': 2, 'sess-099': 1 });
    expect(manifest.session_ids.sort()).toEqual(['sess-001', 'sess-099']);
    expect(manifest.output.csv_path).toBe(result.csvPath);
    expect(manifest.output.manifest_path).toBe(result.manifestPath);
    expect(manifest.output.csv_sha256).toBe(result.hash);
    expect(manifest.output.meta_path).toBe(result.metaPath);
    expect(manifest.source.sim_log_dir).toBe(tempDir);
    expect(manifest.timing).toMatchObject({
      epsilon_seconds: expect.any(Number),
      epsilon_t_seconds: expect.any(Number),
      timezone_offset_seconds: 0,
    });
    expect(manifest.timing.epsilon_seconds).toBeCloseTo(1e-2, 10);
    expect(manifest.timing.epsilon_t_seconds).toBeCloseTo(1e-2, 10);

    expect(manifest.features).toMatchObject({
      augmenter: {
        window_size: DEFAULT_FEATURE_AUGMENTER.windowSize,
        quantiles: DEFAULT_FEATURE_AUGMENTER.quantiles,
        clip_bounds: {
          z: { min: -5, max: 5 },
          z_robust: { min: -5, max: 5 },
          z_hourly: { min: -5, max: 5 },
          log_burst_z: { min: -5, max: 5 },
        },
      },
    });

    const deltaStats = manifest.delta_seconds;
    expect(deltaStats.count).toBe(3);
    expect(deltaStats.mean).toBeCloseTo(3.0, 5);
    expect(deltaStats.median).toBeCloseTo(3.5, 5);
    expect(deltaStats.stddev).toBeGreaterThan(1.07);
    expect(deltaStats.stddev).toBeLessThan(1.09);
    expect(deltaStats.min).toBeCloseTo(1.5, 5);
    expect(deltaStats.max).toBeCloseTo(4.0, 5);

    expect(result.metaPath).not.toBeNull();
    if (!result.metaPath) {
      throw new Error('metaPath should be defined');
    }
    const metaLines = (await fs.readFile(result.metaPath, 'utf8')).trim().split('\n');
    expect(metaLines.length).toBeGreaterThan(0);
    const metaRecord = JSON.parse(metaLines[0]);
    expect(metaRecord.type).toBe('time-anomaly');
    expect(metaRecord).toHaveProperty('propagation_mode');
    expect(metaRecord).toHaveProperty('weights');
  });

  it('ε 推定と time_label を複数解像度で検証する', async () => {
    const fineEvents = [
      {
        timestamp: '2024-05-02T00:00:00.002Z',
        timestamp_utc: '2024-05-02T00:00:00.002Z',
        session_id: 'fine-1',
        user_id: 'fine-1',
        event: 'login',
        method: 'GET' as const,
        path: '/login',
        status: 200,
        deltaSeconds: 0.002,
        metadata: { timezone_offset_seconds: 0 },
      },
      {
        timestamp: '2024-05-02T00:00:00.006Z',
        timestamp_utc: '2024-05-02T00:00:00.006Z',
        session_id: 'fine-1',
        user_id: 'fine-1',
        event: 'view',
        method: 'GET' as const,
        path: '/dashboard',
        status: 200,
        deltaSeconds: 0.004,
      },
      {
        timestamp: '2024-05-02T00:00:00.012Z',
        timestamp_utc: '2024-05-02T00:00:00.012Z',
        session_id: 'fine-1',
        user_id: 'fine-1',
        event: 'logout',
        method: 'POST' as const,
        path: '/logout',
        status: 200,
        deltaSeconds: 0.006,
      },
    ];

    const coarseEvents = [
      {
        timestamp: '2024-05-03T00:00:00.008Z',
        timestamp_utc: '2024-05-03T00:00:00.008Z',
        session_id: 'coarse-1',
        user_id: 'coarse-1',
        event: 'login',
        method: 'GET' as const,
        path: '/login',
        status: 200,
        deltaSeconds: 0.008,
        metadata: { timezone_offset_seconds: 0 },
      },
      {
        timestamp: '2024-05-03T00:00:00.014Z',
        timestamp_utc: '2024-05-03T00:00:00.014Z',
        session_id: 'coarse-1',
        user_id: 'coarse-1',
        event: 'update',
        method: 'POST' as const,
        path: '/resource',
        status: 200,
        deltaSeconds: 0.006,
      },
      {
        timestamp: '2024-05-03T00:00:00.034Z',
        timestamp_utc: '2024-05-03T00:00:00.034Z',
        session_id: 'coarse-1',
        user_id: 'coarse-1',
        event: 'logout',
        method: 'POST' as const,
        path: '/logout',
        status: 200,
        deltaSeconds: 0.02,
      },
    ];

    const fineResult = await persistSimulationRun({
      events: fineEvents,
      runId: 'eps-fine',
      outputDir: tempDir,
    });

    const coarseResult = await persistSimulationRun({
      events: coarseEvents,
      runId: 'eps-coarse',
      outputDir: tempDir,
      parameters: { epsilon_t: 0.01 },
    });

    const fineTiming = fineResult.manifest.timing as Record<string, number>;
    const coarseTiming = coarseResult.manifest.timing as Record<string, number>;
    expect(fineTiming.epsilon_seconds).toBeCloseTo(0.001, 10);
    expect(fineTiming.epsilon_t_seconds).toBeCloseTo(0.001, 10);
    expect(coarseTiming.epsilon_seconds).toBeCloseTo(0.003, 10);
    expect(coarseTiming.epsilon_t_seconds).toBeCloseTo(0.01, 10);

    const coarseCsv = await fs.readFile(coarseResult.csvPath, 'utf8');
    const coarseLines = coarseCsv.trim().split('\n');
    const coarseHeader = coarseLines[0].split(',');
    const coarseIndex = new Map<string, number>();
    coarseHeader.forEach((name, index) => coarseIndex.set(name, index));
    const coarseRows = coarseLines.slice(1).map(parseCsvRow);
    const coarseLabels = coarseRows.map((columns) => columns[coarseIndex.get('time_label') ?? -1]);
    expect(coarseLabels).toEqual(['initial', 'unknown', 'measured']);
  });

  it('runId を自動正規化し、Δt が存在しない場合でも統計を返す', async () => {
    const events = [
      {
        timestamp: '2024-06-01T00:00:00.000Z',
        timestamp_utc: '2024-06-01T00:00:00.000Z',
        session_id: 's-1',
        user_id: 'u-1',
        event: 'login',
      },
    ];

    const result = await persistSimulationRun({ events, runId: '  spaced run:id  ', outputDir: tempDir });
    expect(result.runId).toBe('spaced-run-id');
    expect(path.basename(result.csvPath)).toBe('simEvents-spaced-run-id.csv');

    const stats = summarizeDeltas(result.events);
    expect(stats.count).toBe(0);
    expect(stats.mean).toBeNull();
    expect(stats.median).toBeNull();
    expect(stats.stddev).toBeNull();
  });

  it('augmentRows で Δt 付与とラベルを生成し、オーバーライド関数を受け付ける', () => {
    const rows = [
      {
        session_id: 'sess-1',
        timestamp: '2024-01-01T00:00:00.000Z',
        deltaSeconds: null,
        metadata: {},
      },
      {
        session_id: 'sess-1',
        timestamp: '2024-01-01T00:00:00.005Z',
        deltaSeconds: 0.005,
        metadata: {},
      },
      {
        session_id: 'sess-1',
        timestamp: '2024-01-01T00:00:00.030Z',
        deltaSeconds: 0.025,
        metadata: {},
      },
    ];

    const augmented = augmentRows(rows, {}, { measurementEpsilon: 0.001, epsilonT: 0.01 });
    expect(augmented[0].dt_sec).toBeNull();
    expect(augmented[1].dt_sec).toBeCloseTo(0.005, 6);
    expect(augmented[2].dt_sec).toBeCloseTo(0.025, 6);
    expect(augmented[0].time_label).toBe('initial');
    expect(augmented[1].time_label).toBe('unknown');
    expect(augmented[2].time_label).toBe('measured');
    expect(augmented[2].z).toBeGreaterThan(0);
    expect(augmented[2].z_clipped).toBeGreaterThan(0);
    expect(augmented[2].z).toBeCloseTo(1, 6);
    expect(augmented[2].z_robust).toBeCloseTo(0.67448975, 6);
    expect(augmented[2].z_robust_clipped).toBeCloseTo(0.67448975, 6);
    expect(augmented[2].z_hourly).toBeCloseTo(1, 6);
    expect(augmented[2].log_burst_mean).toBeCloseTo(Math.log(Math.sqrt(0.005 * 0.025)), 6);
    expect(augmented[2].log_burst_std).toBeCloseTo(0.80471896, 6);
    expect(augmented[2].log_burst_z).toBeCloseTo(1, 6);
    expect(augmented[0]['m_q25']).toBeNull();
    expect(augmented[1]['m_q25']).toBeCloseTo(0.005, 6);
    expect(augmented[2]['m_q25']).toBeCloseTo(0.01, 6);
    expect(augmented[2]['m_q50']).toBeCloseTo(0.015, 6);
    expect(augmented[2]['m_q75']).toBeCloseTo(0.02, 6);

    const overridden = augmentRows(rows, {
      dt_sec: () => 5,
      time_label: () => 'measured',
      z_clipped: () => 42,
    });
    expect(overridden[0].dt_sec).toBeNull();
    expect(overridden[1].dt_sec).toBe(5);
    expect(overridden[1].time_label).toBe('measured');
    expect(overridden[2].z_clipped).toBe(42);
  });

  it('augmentRows が窓統計とクリッピングを決定的に適用する', () => {
    const events = makeEventCopies(CLIPPING_EVENTS);
    const augmented = augmentRows(events, {}, {
      measurementEpsilon: 0.01,
      epsilonT: 0.05,
      windowSize: 3,
      quantiles: [0.25, 0.5, 0.9],
      clipBounds: {
        z: { min: -1, max: 1 },
        z_robust: { min: -0.5, max: 0.5 },
        z_hourly: { min: -0.25, max: 0.25 },
        log_burst_z: { min: -0.25, max: 0.25 },
      },
    });

    const clipped = augmented[4];
    expect(clipped.dt_sec).toBeCloseTo(3600, 6);
    expect(clipped.time_label).toBe('measured');
    expect(clipped.z ?? 0).toBeGreaterThan(1);
    expect(clipped.z_clipped).toBeCloseTo(1, 6);
    expect(Math.abs(clipped.z_robust ?? 0)).toBeGreaterThan(0.5);
    expect(clipped.z_robust_clipped).toBeCloseTo(0.5, 6);
    expect(Math.abs(clipped.z_hourly ?? 0)).toBeGreaterThan(0.25);
    expect(clipped.z_hourly_clipped).toBeCloseTo(0.25, 6);
    expect(Math.abs(clipped.log_burst_z ?? 0)).toBeGreaterThan(0.25);
    expect(clipped.log_burst_z_clipped).toBeCloseTo(0.25, 6);
    expect(clipped['m_q25']).toBeLessThan(clipped['m_q50'] as number);
    expect(clipped['m_q90']).toBeGreaterThan(clipped['m_q50'] as number);

    const trailing = augmented[5];
    expect(trailing['m_q25']).toBeLessThan(trailing['m_q90'] as number);
    const trailingLogBurst = trailing.log_burst_z ?? 0;
    expect(Math.abs(trailingLogBurst)).toBeGreaterThan(0.25);
    expect(trailing.log_burst_z_clipped).toBeCloseTo(Math.sign(trailingLogBurst) * 0.25, 6);
  });

  it('formatCsvAugmented で sid_final を session_id で補完し、CSV エスケープを保持する', () => {
    const row = {
      timestamp: '2024-07-01T00:00:00.000Z',
      timestamp_utc: '2024-07-01T00:00:00.000Z',
      session_id: 'sess,comma',
      user_id: 'user"quote',
      event: 'login',
      method: 'POST',
      path: '/auth/login',
      status: 200,
      latency_ms: 100,
      delta_t: 1.23,
      metadata: { message: 'line1\nline2' },
      dt_sec: 1.23,
      log_dt: Math.log(1.23),
      z: 0,
      z_clipped: 0,
      z_robust: 0.1,
      z_robust_clipped: 0.1,
      z_hourly: -0.2,
      z_hourly_clipped: -0.2,
      time_label: 'measured',
      log_burst_mean: -0.1,
      log_burst_std: 0.05,
      log_burst_z: 0.2,
      log_burst_z_clipped: 0.2,
      m_q25: 0.9,
      m_q50: 1.0,
      m_q75: 1.1,
    };

    const csvLine = formatCsvAugmented(row, DEFAULT_FEATURE_COLUMNS);
    const occurrences = csvLine.match(/"sess,comma"/g) || [];
    expect(occurrences).toHaveLength(2);
    expect(csvLine).toContain('"user""quote"');
    expect(csvLine.endsWith('"sess,comma"')).toBe(true);
  });
});
