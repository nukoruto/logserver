import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  persistSimulationRun,
  summarizeDeltas,
  augmentRows,
  formatCsvAugmented,
} from '../../src/sim/persistence/simWriter';
import type { SimulationEvent } from '../../src/services/simulationService';
import { resolveThreshold, type TimeDeviationOptions } from '../../src/sim/detector/timeDeviationDetector';

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
      'timestamp,session_id,user_id,event,method,path,status,latency_ms,delta_t,metadata,dt_sec,log_dt,z,z_clipped,time_label,sid_final'
    );
    expect(rows).toHaveLength(events.length + 1);

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

    const sidFinalValues = parsedRows.map((columns: string[]) => columns[15]);
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

    const deltaStats = manifest.delta_seconds;
    expect(deltaStats.count).toBe(3);
    expect(deltaStats.mean).toBeCloseTo(3.0, 5);
    expect(deltaStats.median).toBeCloseTo(3.5, 5);
    expect(deltaStats.stddev).toBeGreaterThan(1.07);
    expect(deltaStats.stddev).toBeLessThan(1.09);
    expect(deltaStats.min).toBeCloseTo(1.5, 5);
    expect(deltaStats.max).toBeCloseTo(4.0, 5);
  });

  it('SPOT メタデータを Δt 統計とマニフェストに保持する', async () => {
    const tailBaseline = [0.5, 0.7, 1.2, 1.6, 3.8, 0.6, 0.9, 4.5, 0.4, 2.3, 0.3, 5.1];
    const calibrationOptions: TimeDeviationOptions = {
      method: 'spot',
      quantile: 0.9,
      spotTailFraction: 0.25,
      spotTargetProbability: 0.05,
      spotMinTailCount: 3,
    };
    const optionsCopy: TimeDeviationOptions = { ...calibrationOptions };
    resolveThreshold(tailBaseline, optionsCopy);
    const meta = optionsCopy.spotMetadata;
    expect(meta).toBeDefined();
    if (!meta) {
      throw new Error('expected SPOT metadata for manifest test');
    }

    const events: SimulationEvent[] = tailBaseline.map((delta, index) => ({
      timestamp: `2024-07-01T00:00:${`${index}`.padStart(2, '0')}.000Z`,
      session_id: 'sess-spot',
      user_id: 'user-spot',
      event: `evt-${index}`,
      deltaSeconds: delta,
      timeDeviationFlag: delta > meta.tauT,
      timeDeviationThresholdSeconds: meta.tauT,
      timeDeviationSpotTauTSeconds: meta.tauT,
      timeDeviationSpotUSeconds: meta.u,
      timeDeviationSpotXi: meta.xi,
      timeDeviationSpotBeta: meta.beta,
      timeDeviationSpotPRef: meta.pRef,
      timeDeviationSpotQStar: meta.qStar,
      timeDeviationSpotTailCount: meta.tailCount,
      timeDeviationSpotSampleCount: meta.sampleCount,
    }));

    const stats = summarizeDeltas(events);
    expect(stats.spot).toBeDefined();
    const spot = stats.spot as Record<string, unknown>;
    expect(spot.method).toBe('spot');
    expect(Number(spot.u_seconds)).toBeCloseTo(meta.u, 9);
    expect(Number(spot.tau_t_seconds)).toBeCloseTo(meta.tauT, 9);
    expect(Number(spot.p_ref)).toBeCloseTo(meta.pRef, 9);
    expect(Number(spot.q_star)).toBeCloseTo(meta.qStar, 9);
    expect(Number(spot.tail_count)).toBe(meta.tailCount);
    expect(Number(spot.sample_count)).toBe(meta.sampleCount);

    const result = await persistSimulationRun({
      events,
      runId: 'spot-meta-test',
      outputDir: tempDir,
      scenarioId: 'spot-scenario',
    });

    const manifestRaw = await fs.readFile(result.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.delta_seconds.spot).toBeDefined();
    const manifestSpot = manifest.delta_seconds.spot as Record<string, unknown>;
    expect(manifestSpot.method).toBe('spot');
    expect(Number(manifestSpot.tau_t_seconds)).toBeCloseTo(meta.tauT, 9);
    expect(Number(manifestSpot.u_seconds)).toBeCloseTo(meta.u, 9);
    expect(Number(manifestSpot.p_ref)).toBeCloseTo(meta.pRef, 9);
    expect(Number(manifestSpot.q_star)).toBeCloseTo(meta.qStar, 9);
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

    const overridden = augmentRows(rows, {
      dt_sec: () => 5,
      time_label: () => 'ok',
      z_clipped: () => 42,
    });
    expect(overridden[0].dt_sec).toBe(5);
    expect(overridden[1].time_label).toBe('ok');
    expect(overridden[2].z_clipped).toBe(42);
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
    };

    const csvLine = formatCsvAugmented(row);
    const occurrences = csvLine.match(/"sess,comma"/g) || [];
    expect(occurrences).toHaveLength(2);
    expect(csvLine).toContain('"user""quote"');
    expect(csvLine.endsWith('"sess,comma"')).toBe(true);
  });
});
