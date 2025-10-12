import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateScenario } from '../../src/services/simulationService';

describe('simulationService.generateScenario', () => {
  let tempDir: string;
  let originalSimLogDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'sim-service-'));
    originalSimLogDir = process.env.SIM_LOG_DIR;
    process.env.SIM_LOG_DIR = tempDir;
  });

  afterEach(() => {
    if (originalSimLogDir === undefined) {
      delete process.env.SIM_LOG_DIR;
    } else {
      process.env.SIM_LOG_DIR = originalSimLogDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates events, manifest metadata, and anomaly summary', async () => {
    const result = await generateScenario({
      count: 12,
      anomalies: ['timeDeviation', 'authenticationBypass'],
      seed: 'jest-service',
      outputDir: tempDir,
      runId: 'jest-service',
      csvFileName: 'events.csv',
      manifestFileName: 'manifest.json',
      anomalyCount: 2,
      startTime: '2024-01-01T00:00:00.000Z',
      sessionSpacingSeconds: 30,
    });

    expect(result.events).toHaveLength(12);
    expect(result.summary.events).toBe(12);
    expect(result.summary.sessions).toBeGreaterThanOrEqual(1);
    expect(result.summary.anomalies.normal).toBeGreaterThan(0);
    expect(result.params.seed).toBe('jest-service');
    expect(result.params.seed_source).toBe('provided');
    expect(result.scenarioId).toBeTruthy();

    const firstEvent = result.events[0];
    expect(firstEvent).toHaveProperty('session_id');
    expect(firstEvent).toHaveProperty('metadata');
    expect(firstEvent.metadata).toHaveProperty('scenario');

    expect(result.files?.csvPath).toBeDefined();
    expect(result.files?.manifestPath).toBeDefined();
    expect(result.manifest).toBeDefined();

    if (result.files?.csvPath) {
      expect(existsSync(result.files.csvPath)).toBe(true);
    }
    if (result.files?.manifestPath) {
      const manifestContent = readFileSync(result.files.manifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent);
      expect(manifest.counts.events).toBe(12);
      expect(manifest.anomaly_summary.normal).toBeGreaterThan(0);
      expect(manifest.parameters.seed).toBe('jest-service');
      expect(manifest.parameters.seed_source).toBe('provided');
    }
  });

  it('produces identical sequences when the same seed is supplied', async () => {
    const baseOptions = {
      count: 20,
      anomalies: ['protocolViolation', 'timeDeviation'],
      seed: 'repeatable-seed',
      persist: false,
      maxSteps: 32,
      sessionSpacingSeconds: 60,
      startTime: '2024-03-01T00:00:00.000Z',
    };

    const first = await generateScenario(baseOptions);
    const second = await generateScenario(baseOptions);

    expect(second.params.seed).toBe('repeatable-seed');
    expect(second.events).toStrictEqual(first.events);
    expect(second.summary).toStrictEqual(first.summary);
  });

  it('records generated seeds when none are provided', async () => {
    const result = await generateScenario({
      count: 8,
      persist: false,
    });

    expect(typeof result.params.seed).toBe('string');
    expect(result.params.seed.length).toBeGreaterThan(0);
    expect(result.params.seed_source).toBe('generated');
  });
});

export {};
