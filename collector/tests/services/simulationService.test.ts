import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateScenario } from '../../src/services/simulationService';

describe('simulationService.generateScenario', () => {
  let tempDir: string;
  let originalSimLogDir: string | undefined;
  let originalJwtKey: string | undefined;
  let originalSidSalt: string | undefined;
  let originalNtpStatePath: string | undefined;
  let ntpStateDir: string | null = null;
  const jwtHeaderPrefix = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
  const expectedSaltB64 = 'AAECAwQFBgcICQoLDA0ODw';

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'sim-service-'));
    originalSimLogDir = process.env.SIM_LOG_DIR;
    process.env.SIM_LOG_DIR = tempDir;
    originalJwtKey = process.env.JWT_HMAC_KEY;
    originalSidSalt = process.env.SID_SALT_B64;
    originalNtpStatePath = process.env.NTP_STATE_PATH;
    process.env.JWT_HMAC_KEY = 'c2ltdWxhdGVkLWp3dC1zZWNyZXQ=';
    process.env.SID_SALT_B64 = 'AAECAwQFBgcICQoLDA0ODw==';
    ntpStateDir = mkdtempSync(path.join(os.tmpdir(), 'sim-service-ntp-'));
    const ntpStatePath = path.join(ntpStateDir, 'ntp.json');
    writeFileSync(ntpStatePath, JSON.stringify({ p95_ms: 20, lastMeasuredAt: new Date().toISOString() }));
    process.env.NTP_STATE_PATH = ntpStatePath;
  });

  afterEach(() => {
    if (originalSimLogDir === undefined) {
      delete process.env.SIM_LOG_DIR;
    } else {
      process.env.SIM_LOG_DIR = originalSimLogDir;
    }
    if (originalJwtKey === undefined) {
      delete process.env.JWT_HMAC_KEY;
    } else {
      process.env.JWT_HMAC_KEY = originalJwtKey;
    }
    if (originalSidSalt === undefined) {
      delete process.env.SID_SALT_B64;
    } else {
      process.env.SID_SALT_B64 = originalSidSalt;
    }
    if (originalNtpStatePath === undefined) {
      delete process.env.NTP_STATE_PATH;
    } else {
      process.env.NTP_STATE_PATH = originalNtpStatePath;
    }
    if (ntpStateDir) {
      rmSync(ntpStateDir, { recursive: true, force: true });
      ntpStateDir = null;
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
      kid: 'SERVICE-KID-001',
    });

    expect(result.events).toHaveLength(12);
    expect(result.summary.events).toBe(12);
    expect(result.summary.sessions).toBeGreaterThanOrEqual(1);
    expect(result.summary.anomalies.normal).toBeGreaterThan(0);
    expect(result.params.seed).toBe('jest-service');
    expect(result.params.seed_source).toBe('provided');
    expect(result.params.time_anomaly.mode).toBe('auto');
    expect(result.params.time_anomaly.weights.propagate).toBeCloseTo(0.7, 5);
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
      expect(manifest.schema_sha256).toBe(result.files?.schemaSha256);
      expect(manifest.output.run_meta_path).toBe(result.files?.runMetaPath);
      expect(manifest.output.schema_path).toBe(result.files?.schemaPath);
      expect(manifest.output.audit_path).toBe(result.files?.auditPath);
      expect(manifest.kid).toBe('SERVICE-KID-001');
      expect(manifest.crypto).toEqual({
        kid: result.run_meta?.crypto.kid,
        kdf: 'hkdf-sha256',
        info: 'sid',
        salt_b64: expectedSaltB64,
        keylen: 32,
        algo_ver: 'sid-hkdf-sha256-v1',
      });
      if (result.files.metaPath) {
        expect(manifest.output.meta_path).toBe(result.files.metaPath);
      }
    }
    expect(result.run_meta).toBeDefined();
    if (result.run_meta) {
      expect(result.run_meta.kid).toBe('SERVICE-KID-001');
      expect(result.run_meta.data_fingerprint.schema_sha256).toBe(result.files?.schemaSha256 ?? null);
      expect(result.run_meta.crypto).toMatchObject({
        kdf: 'hkdf-sha256',
        info: 'sid',
        salt_b64: expectedSaltB64,
        keylen: 32,
        algo_ver: 'sid-hkdf-sha256-v1',
      });
      expect(result.run_meta.crypto.kid).toMatch(/^[0-9a-f]{16}$/);
    }
    if (result.files?.runMetaPath) {
      expect(existsSync(result.files.runMetaPath)).toBe(true);
    }
    if (result.files?.schemaPath) {
      expect(existsSync(result.files.schemaPath)).toBe(true);
    }
    if (result.files?.auditPath) {
      expect(existsSync(result.files.auditPath)).toBe(true);
    }
    if (result.files?.metaPath) {
      expect(existsSync(result.files.metaPath)).toBe(true);
      const metaContent = readFileSync(result.files.metaPath, 'utf8').trim().split('\n');
      expect(metaContent.length).toBeGreaterThan(0);
      const firstMeta = JSON.parse(metaContent[0]);
      expect(firstMeta).toHaveProperty('propagation_mode');
      expect(firstMeta).toHaveProperty('weights');
    }
  });

  it('derives deterministic uids and avoids persisting raw JWT tokens', async () => {
    const baseOptions = {
      count: 10,
      anomalies: ['timeDeviation'],
      seed: 'jwt-deterministic',
      outputDir: tempDir,
      runId: 'jwt-deterministic',
      csvFileName: 'events.csv',
      manifestFileName: 'manifest.json',
      runMetaFileName: 'run_meta.json',
      includeFeaturesCsv: true,
    } as const;

    const first = await generateScenario(baseOptions);
    const second = await generateScenario(baseOptions);

    const firstUids = first.events.map((event) => event.uid);
    const secondUids = second.events.map((event) => event.uid);
    expect(firstUids).toHaveLength(first.events.length);
    expect(secondUids).toEqual(firstUids);
    firstUids.forEach((uid) => {
      expect(uid).toMatch(/^[0-9a-f]{64}$/);
    });

    expect(first.run_meta).toBeDefined();
    expect(first.run_meta?.crypto.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(first.run_meta?.crypto).toMatchObject({
      kdf: 'hkdf-sha256',
      info: 'sid',
      salt_b64: expectedSaltB64,
      keylen: 32,
      algo_ver: 'sid-hkdf-sha256-v1',
    });

    const pathsToVerify = [
      first.files?.csvPath,
      first.files?.manifestPath,
      first.files?.runMetaPath,
      first.files?.auditPath,
      first.files?.featuresCsvPath ?? undefined,
    ].filter((candidate): candidate is string => typeof candidate === 'string');

    pathsToVerify.forEach((filePath) => {
      const content = readFileSync(filePath, 'utf8');
      expect(content).not.toContain(jwtHeaderPrefix);
    });
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
    expect(second.params.time_anomaly).toStrictEqual(first.params.time_anomaly);
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
