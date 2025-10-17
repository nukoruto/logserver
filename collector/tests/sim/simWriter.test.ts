import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  persistSimulationRun,
  summarizeDeltas,
  augmentRows,
  formatCsvAugmented,
} from '../../src/sim/persistence/simWriter';

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
    expect(rows[0]).toBe(
      'timestamp,timestamp_utc,session_id,user_id,event,method,path,status,latency_ms,delta_t,metadata,dt_sec,log_dt,z,z_clipped,time_label,sid_final'
    );
    expect(rows).toHaveLength(events.length + 1);

    const parsedRows = rows.slice(1).map(parseCsvRow);
    const metadataRows = parsedRows.map((columns: string[]) => JSON.parse(columns[10] || '{}'));
    expect(metadataRows[0].anomaly).toBe('normal');
    expect(metadataRows[1].anomaly).toBe('protocol_violation');
    expect(metadataRows[2].anomaly).toBe('time_deviation');

    const dtValues = parsedRows.map((columns: string[]) => columns[11]);
    expect(dtValues).toEqual(['', '3.5', '']);

    const logDtValues = parsedRows.map((columns: string[]) => columns[12]);
    expect(logDtValues[0]).toBe('');
    expect(Number(logDtValues[1])).toBeCloseTo(Math.log(3.5), 6);
    expect(logDtValues[2]).toBe('');

    const zValues = parsedRows.map((columns: string[]) => columns[13]);
    expect(zValues).toEqual(['', '0', '']);

    const clippedValues = parsedRows.map((columns: string[]) => columns[14]);
    expect(clippedValues).toEqual(['', '0', '']);

    const labelValues = parsedRows.map((columns: string[]) => columns[15]);
    expect(labelValues).toEqual(['initial', 'measured', 'initial']);

    const sidFinalValues = parsedRows.map((columns: string[]) => columns[16]);
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
    expect(manifest.timing).toMatchObject({
      epsilon_seconds: expect.any(Number),
      epsilon_t_seconds: expect.any(Number),
      timezone_offset_seconds: 0,
    });
    expect(manifest.timing.epsilon_seconds).toBeCloseTo(1e-2, 10);
    expect(manifest.timing.epsilon_t_seconds).toBeCloseTo(1e-2, 10);

    const deltaStats = manifest.delta_seconds;
    expect(deltaStats.count).toBe(3);
    expect(deltaStats.mean).toBeCloseTo(3.0, 5);
    expect(deltaStats.median).toBeCloseTo(3.5, 5);
    expect(deltaStats.stddev).toBeGreaterThan(1.07);
    expect(deltaStats.stddev).toBeLessThan(1.09);
    expect(deltaStats.min).toBeCloseTo(1.5, 5);
    expect(deltaStats.max).toBeCloseTo(4.0, 5);
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
    const coarseRows = coarseCsv.trim().split('\n').slice(1).map(parseCsvRow);
    const coarseLabels = coarseRows.map((columns) => columns[15]);
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
      time_label: 'measured',
    };

    const csvLine = formatCsvAugmented(row);
    const occurrences = csvLine.match(/"sess,comma"/g) || [];
    expect(occurrences).toHaveLength(2);
    expect(csvLine).toContain('"user""quote"');
    expect(csvLine.endsWith('"sess,comma"')).toBe(true);
  });
});
