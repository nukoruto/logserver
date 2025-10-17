import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  persistSimulationRun,
  summarizeDeltas,
  augmentRows,
  formatCsvAugmented,
} from '../../src/sim/persistence/simWriter';
import type { AugmentedSimulationEvent } from '../../src/sim/persistence/simWriter';

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

  it('feature オプションで量子化列とクリップを決定的に制御できる', async () => {
    const events = [
      {
        timestamp: '2024-06-02T00:00:00.000Z',
        session_id: 'sess-a',
        user_id: 'user-a',
        event: 'login',
        method: 'POST' as const,
        path: '/auth/login',
        status: 200,
        latency_ms: 80,
        deltaSeconds: 0.5,
      },
      {
        timestamp: '2024-06-02T01:00:00.000Z',
        session_id: 'sess-a',
        user_id: 'user-a',
        event: 'browse',
        method: 'GET' as const,
        path: '/reports',
        status: 200,
        latency_ms: 120,
        deltaSeconds: 8.0,
      },
      {
        timestamp: '2024-06-02T02:00:00.000Z',
        session_id: 'sess-b',
        user_id: 'user-b',
        event: 'edit',
        method: 'POST' as const,
        path: '/records',
        status: 200,
        latency_ms: 140,
        deltaSeconds: 12.0,
      },
    ];

    const featureOptions = {
      windowSize: 2,
      clipBounds: { min: -1, max: 1 },
      quantiles: [0.25, 0.75],
      logBurstThreshold: Math.log(1.1),
    };

    const result = await persistSimulationRun({
      events,
      outputDir: tempDir,
      featureOptions,
    });

    const csvContent = await fs.readFile(result.csvPath, 'utf8');
    const rows = csvContent.trim().split('\n');
    expect(rows[0]).toBe(
      'timestamp,session_id,user_id,event,method,path,status,latency_ms,delta_t,metadata,dt_sec,log_dt,z,z_clipped,time_label,z_robust,z_hourly,m_q_0_25,m_q_0_75,log_burst_delta,log_burst_flag,sid_final'
    );

    const parsedRows = rows.slice(1).map(parseCsvRow);
    const zClippedValues = parsedRows.map((columns: string[]) => Number(columns[13]));
    expect(zClippedValues.every((value) => Math.abs(value) <= 1)).toBe(true);

    const quantile25 = parsedRows.map((columns: string[]) => Number(columns[17]));
    expect(quantile25[0]).toBeCloseTo(0.5, 6);
    expect(quantile25[1]).toBeGreaterThan(2);

    const quantile75 = parsedRows.map((columns: string[]) => Number(columns[18]));
    expect(quantile75[1]).toBeGreaterThan(6);
    expect(quantile75[2]).toBeCloseTo(11, 1);

    const logBurstFlags = parsedRows.map((columns: string[]) => Number(columns[20]));
    expect(logBurstFlags).toEqual([0, 1, 1]);

    const manifestRaw = await fs.readFile(result.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.feature_augmenter).toEqual({
      window_size: 2,
      clip_bounds: { min: -1, max: 1 },
      quantiles: [0.25, 0.75],
      quantile_labels: ['m_q_0_25', 'm_q_0_75'],
      log_burst_threshold: Math.log(1.1),
    });
    expect(manifest.feature_columns).toEqual([
      'dt_sec',
      'log_dt',
      'z',
      'z_clipped',
      'time_label',
      'z_robust',
      'z_hourly',
      'm_q_0_25',
      'm_q_0_75',
      'log_burst_delta',
      'log_burst_flag',
    ]);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('CSV とマニフェストを生成し、異常サマリと Δt 統計を格納する', async () => {
    const events = [
      {
        timestamp: '2024-05-01T00:00:01.000Z',
        session_id: 'sess-001',
        user_id: 'user-001',
        event: 'login',
        method: 'POST' as const,
        path: '/auth/login',
        status: 200,
        latency_ms: 120,
        deltaSeconds: 1.5,
        metadata: { op_category: 'AUTH' },
      },
      {
        timestamp: '2024-05-01T00:00:05.000Z',
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
    expect(rows[0]).toBe(
      'timestamp,session_id,user_id,event,method,path,status,latency_ms,delta_t,metadata,dt_sec,log_dt,z,z_clipped,time_label,z_robust,z_hourly,m_q_0_5,m_q_0_9,m_q_0_99,log_burst_delta,log_burst_flag,sid_final'
    );
    expect(rows).toHaveLength(events.length + 1);

    const parsedRows = rows.slice(1).map(parseCsvRow);
    const metadataRows = parsedRows.map((columns: string[]) =>
      JSON.parse(columns[9] || '{}')
    );
    expect(metadataRows[0].anomaly).toBe('normal');
    expect(metadataRows[1].anomaly).toBe('protocol_violation');
    expect(metadataRows[2].anomaly).toBe('time_deviation');

    const dtValues = parsedRows.map((columns: string[]) => columns[10]);
    expect(dtValues).toEqual(['1.5', '3.5', '4']);

    const logDtValues = parsedRows.map((columns: string[]) => Number(columns[11]));
    expect(logDtValues[0]).toBeCloseTo(Math.log(1.5), 6);
    expect(logDtValues[1]).toBeCloseTo(Math.log(3.5), 6);
    expect(logDtValues[2]).toBeCloseTo(Math.log(4), 6);

    const zValues = parsedRows.map((columns: string[]) => Number(columns[12]));
    expect(zValues[0]).toBeLessThan(0);
    expect(zValues[2]).toBeGreaterThan(0);

    const clippedValues = parsedRows.map((columns: string[]) => Number(columns[13]));
    expect(clippedValues).toEqual(zValues);

    const labelValues = parsedRows.map((columns: string[]) => columns[14]);
    expect(labelValues).toEqual(['ok', 'ok', 'ok']);

    const zRobustValues = parsedRows.map((columns: string[]) => Number(columns[15]));
    expect(zRobustValues[0]).toBeLessThanOrEqual(0);
    expect(zRobustValues[1]).toBeCloseTo(0, 6);

    const zHourlyValues = parsedRows.map((columns: string[]) => Number(columns[16]));
    expect(zHourlyValues[0]).toBeLessThanOrEqual(0);
    expect(zHourlyValues[2]).toBeGreaterThanOrEqual(0);

    const q50 = parsedRows.map((columns: string[]) => Number(columns[17]));
    expect(q50[0]).toBeCloseTo(1.5, 6);
    expect(q50[1]).toBeCloseTo(2.5, 6);
    expect(q50[2]).toBeCloseTo(3.5, 6);

    const q90 = parsedRows.map((columns: string[]) => Number(columns[18]));
    expect(q90[1]).toBeCloseTo(3.3, 6);
    expect(q90[2]).toBeCloseTo(3.9, 6);

    const q99 = parsedRows.map((columns: string[]) => Number(columns[19]));
    expect(q99[1]).toBeCloseTo(3.48, 6);
    expect(q99[2]).toBeCloseTo(3.99, 6);

    const logBurstDelta = parsedRows.map((columns: string[]) => Number(columns[20]));
    expect(logBurstDelta[0]).toBeCloseTo(0, 6);
    expect(logBurstDelta[1]).toBeGreaterThan(0);

    const logBurstFlags = parsedRows.map((columns: string[]) => Number(columns[21]));
    expect(logBurstFlags).toEqual([0, 0, 0]);

    const sidFinalValues = parsedRows.map((columns: string[]) => columns[22]);
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
    expect(manifest.source.sim_log_dir).toBe(tempDir);
    expect(manifest.feature_augmenter).toEqual({
      window_size: 8,
      clip_bounds: { min: -5, max: 5 },
      quantiles: [0.5, 0.9, 0.99],
      quantile_labels: ['m_q_0_5', 'm_q_0_9', 'm_q_0_99'],
      log_burst_threshold: Math.log(2),
    });
    expect(manifest.feature_columns).toEqual([
      'dt_sec',
      'log_dt',
      'z',
      'z_clipped',
      'time_label',
      'z_robust',
      'z_hourly',
      'm_q_0_5',
      'm_q_0_9',
      'm_q_0_99',
      'log_burst_delta',
      'log_burst_flag',
    ]);

    const deltaStats = manifest.delta_seconds;
    expect(deltaStats.count).toBe(3);
    expect(deltaStats.mean).toBeCloseTo(3.0, 5);
    expect(deltaStats.median).toBeCloseTo(3.5, 5);
    expect(deltaStats.stddev).toBeGreaterThan(1.07);
    expect(deltaStats.stddev).toBeLessThan(1.09);
    expect(deltaStats.min).toBeCloseTo(1.5, 5);
    expect(deltaStats.max).toBeCloseTo(4.0, 5);
  });

  it('runId を自動正規化し、Δt が存在しない場合でも統計を返す', async () => {
    const events = [
      {
        timestamp: '2024-06-01T00:00:00.000Z',
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
      { deltaSeconds: 0, metadata: {} },
      { deltaSeconds: null, metadata: {} },
      { deltaSeconds: 10, metadata: {} },
    ];

    const augmented = augmentRows(rows);
    expect(augmented[0].dt_sec).toBeNull();
    expect(augmented[1].dt_sec).toBeNull();
    expect(augmented[2].dt_sec).toBe(10);
    expect(augmented[0].time_label).toBe('unknown');
    expect(augmented[2].time_label).toBe('ok');
    expect(augmented[2].z).toBe(0);
    expect(augmented[2].z_clipped).toBe(0);
    expect(augmented[2].z_robust).toBe(0);
    expect(augmented[2].z_hourly).toBeNull();
    expect(Number((augmented[2] as Record<string, unknown>).m_q_0_5)).toBe(10);
    expect(augmented[2].log_burst_delta).toBeCloseTo(0, 12);
    expect(augmented[2].log_burst_flag).toBe(0);

    const overridden = augmentRows(rows, {
      dt_sec: () => 5,
      time_label: () => 'ok',
      z_clipped: () => 42,
      log_burst_flag: () => 7,
    });
    expect(overridden[0].dt_sec).toBe(5);
    expect(overridden[1].time_label).toBe('ok');
    expect(overridden[2].z_clipped).toBe(42);
    expect(overridden[2].log_burst_flag).toBe(7);

    const customOptions = augmentRows(rows, {}, {
      windowSize: 1,
      clipBounds: { min: -1, max: 1 },
      quantiles: [0.25, 0.75],
      logBurstThreshold: Math.log(1.1),
    });
    expect(Number((customOptions[2] as Record<string, unknown>).m_q_0_25)).toBe(10);
    expect(Number((customOptions[2] as Record<string, unknown>).m_q_0_75)).toBe(10);
    expect(customOptions[2].log_burst_flag).toBe(0);
  });

  it('formatCsvAugmented で sid_final を session_id で補完し、CSV エスケープを保持する', () => {
    const row = {
      timestamp: '2024-07-01T00:00:00.000Z',
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
      time_label: 'ok',
      z_robust: 0,
      z_hourly: 0,
      log_burst_delta: 0,
      log_burst_flag: 0,
      m_q_0_5: 1.23,
      m_q_0_9: 1.23,
      m_q_0_99: 1.23,
    } as AugmentedSimulationEvent & Record<string, unknown>;

    const csvLine = formatCsvAugmented(row);
    const occurrences = csvLine.match(/"sess,comma"/g) || [];
    expect(occurrences).toHaveLength(2);
    expect(csvLine).toContain('"user""quote"');
    expect(csvLine.endsWith('"sess,comma"')).toBe(true);
  });
});
