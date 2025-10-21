import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  persistSimulationRun,
  summarizeDeltas,
  augmentRows,
  formatCsvAugmented,
  DEFAULT_FEATURE_AUGMENTER,
  validateContractColumns,
} from '../../src/sim/persistence/simWriter';
import type {
  AugmentedSimulationEvent,
  SessionCryptoMetadata,
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
  'uid',
  'session_id',
  'method',
  'path',
  'referer',
  'user_agent',
  'ip',
  'cookie',
  'op_category',
];

const FEATURE_FILE_ADDITIONAL_COLUMNS = [
  'user_id',
  'event',
  'status_code',
  'latency_ms',
  'delta_t',
  'metadata',
];

const CSV_TRAILING_COLUMN = 'sid_final';

const DEFAULT_CRYPTO_METADATA: SessionCryptoMetadata = {
  kid: 'abcd1234abcd1234',
  kdf: 'hkdf-sha256',
  info: 'sid',
  salt_b64: '',
  keylen: 32,
  algo_ver: 'sid-hkdf-sha256-v1',
};

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
        uid: '4d2f8f23ad604d5bb9d6c3d2f9ab31ff',
        event: 'login',
        method: 'POST' as const,
        path: '/auth/login',
        status: 200,
        latency_ms: 120,
        deltaSeconds: 1.5,
        cookie: 'sid=4d2f8f23ad604d5bb9d6c3d2f9ab31ff.001; Path=/; HttpOnly; Secure',
        metadata: {
          op_category: 'AUTH',
          timezone_offset_seconds: 0,
          headers: {
            Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.payload.signature',
            'Set-Cookie': 'session=raw-token; HttpOnly',
          },
          cookie: 'session=raw-token; HttpOnly',
          tokens: { jwt: 'eyJraWQiOiIxMjMifQ.fake.payload.signature' },
        },
        op_category: 'AUTH',
      },
      {
        timestamp: '2024-05-01T00:00:05.000Z',
        timestamp_utc: '2024-05-01T00:00:05.000Z',
        session_id: 'sess-001',
        user_id: 'user-001',
        uid: '4d2f8f23ad604d5bb9d6c3d2f9ab31ff',
        event: 'delete',
        method: 'DELETE' as const,
        path: '/projects/alpha',
        status: 403,
        latency_ms: 210,
        deltaSeconds: 3.5,
        cookie: 'sid=4d2f8f23ad604d5bb9d6c3d2f9ab31ff.001; Path=/; HttpOnly; Secure',
        protocolViolationFlag: true,
        protocolViolationReasons: ['disallowedTransition'],
      },
      {
        timestamp: '2024-05-01T00:00:09.000Z',
        timestamp_utc: '2024-05-01T00:00:09.000Z',
        session_id: 'sess-099',
        sid_final: 'explicit-sid-099',
        user_id: 'user-314',
        uid: '2c5c2f3adab04d969e9a5c2a12acb7d0',
        event: 'browse',
        method: 'GET' as const,
        path: '/reports/daily',
        status: 200,
        latency_ms: 90,
        deltaSeconds: 4.0,
        cookie: 'sid=2c5c2f3adab04d969e9a5c2a12acb7d0.099; Path=/; HttpOnly; Secure',
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
      includeFeaturesCsv: true,
      kid: 'KID-UNIT-001',
      crypto: DEFAULT_CRYPTO_METADATA,
      allowedIssuers: [' https://issuer.example ', 'https://issuer.example'],
    });

    expect(result.runId).toBe('unit-test-001');
    expect(path.basename(result.csvPath)).toBe('simEvents-unit-test-001.csv');
    expect(path.basename(result.manifestPath)).toBe('scenario-unit-test-001.json');
    expect(path.basename(result.fairPath)).toBe('fair.json');
    expect(path.basename(result.datasheetPath)).toBe('datasheet.json');
    expect(path.basename(result.provenancePath)).toBe('provenance.json');

    const csvContent = await fs.readFile(result.csvPath, 'utf8');
    const baseRows = csvContent.trim().split('\n');
    const baseHeader = baseRows[0].split(',');
    expect(baseHeader).toEqual(CSV_BASE_COLUMNS);
    expect(baseRows).toHaveLength(events.length + 1);
    expect(csvContent.toLowerCase()).not.toContain('authorization');

    const baseHeaderIndex = new Map<string, number>();
    baseHeader.forEach((name, index) => baseHeaderIndex.set(name, index));
    const baseValueAt = (columns: string[], name: string): string => {
      const position = baseHeaderIndex.get(name);
      if (position === undefined) {
        throw new Error(`Column ${name} not found in base header`);
      }
      return columns[position] ?? '';
    };

    const baseParsedRows = baseRows.slice(1).map(parseCsvRow);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'uid'))).toEqual([
      '4d2f8f23ad604d5bb9d6c3d2f9ab31ff',
      '4d2f8f23ad604d5bb9d6c3d2f9ab31ff',
      '2c5c2f3adab04d969e9a5c2a12acb7d0',
    ]);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'session_id'))).toEqual([
      'sess-001',
      'sess-001',
      'sess-099',
    ]);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'method'))).toEqual(['POST', 'DELETE', 'GET']);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'path'))).toEqual([
      '/auth/login',
      '/projects/alpha',
      '/reports/daily',
    ]);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'referer'))).toEqual(['null', 'null', 'null']);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'user_agent'))).toEqual(['null', 'null', 'null']);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'ip'))).toEqual(['null', 'null', 'null']);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'cookie'))).toEqual([
      'sid=4d2f8f23ad604d5bb9d6c3d2f9ab31ff.001; Path=/; HttpOnly; Secure',
      'sid=4d2f8f23ad604d5bb9d6c3d2f9ab31ff.001; Path=/; HttpOnly; Secure',
      'sid=2c5c2f3adab04d969e9a5c2a12acb7d0.099; Path=/; HttpOnly; Secure',
    ]);
    expect(baseParsedRows.map((columns) => baseValueAt(columns, 'op_category'))).toEqual([
      'AUTH',
      'null',
      'null',
    ]);
    const timestampUtcValues = baseParsedRows.map((columns) => Number(baseValueAt(columns, 'timestamp_utc')));
    expect(timestampUtcValues).toEqual([1714521601, 1714521605, 1714521609]);

    expect(result.featuresCsvPath).not.toBeNull();
    if (!result.featuresCsvPath) {
      throw new Error('featuresCsvPath should be defined when includeFeaturesCsv is true');
    }
    const featuresContent = await fs.readFile(result.featuresCsvPath, 'utf8');
    const featureRows = featuresContent.trim().split('\n');
    const featureHeader = featureRows[0].split(',');
    expect(featureHeader).toEqual([
      ...CSV_BASE_COLUMNS,
      ...FEATURE_FILE_ADDITIONAL_COLUMNS,
      ...DEFAULT_FEATURE_COLUMNS,
      CSV_TRAILING_COLUMN,
    ]);
    const featureHeaderIndex = new Map<string, number>();
    featureHeader.forEach((name, index) => featureHeaderIndex.set(name, index));
    const featureValueAt = (columns: string[], name: string): string => {
      const position = featureHeaderIndex.get(name);
      if (position === undefined) {
        throw new Error(`Column ${name} not found in feature header`);
      }
      return columns[position] ?? '';
    };

    const featureParsedRows = featureRows.slice(1).map(parseCsvRow);
    expect(featureParsedRows.map((columns) => featureValueAt(columns, 'status_code'))).toEqual(['200', '403', '200']);
    const metadataRows = featureParsedRows.map((columns) => JSON.parse(featureValueAt(columns, 'metadata') || '{}'));
    expect(metadataRows[0].anomaly).toBe('normal');
    expect(metadataRows[1].anomaly).toBe('protocol_violation');
    expect(metadataRows[2].anomaly).toBe('time_deviation');
    expect(metadataRows[0]).not.toHaveProperty('cookie');
    expect(metadataRows[0]).not.toHaveProperty('headers');
    expect(metadataRows[0]).not.toHaveProperty('tokens');
    const dtValues = featureParsedRows.map((columns) => featureValueAt(columns, 'dt_sec'));
    expect(dtValues).toEqual(['', '3.5', '']);
    const logDtValues = featureParsedRows.map((columns) => featureValueAt(columns, 'log_dt'));
    expect(logDtValues[0]).toBe('');
    expect(Number(logDtValues[1])).toBeCloseTo(Math.log(3.5), 6);
    expect(logDtValues[2]).toBe('');
    const zValues = featureParsedRows.map((columns) => featureValueAt(columns, 'z'));
    expect(zValues).toEqual(['', '0', '']);
    const clippedValues = featureParsedRows.map((columns) => featureValueAt(columns, 'z_clipped'));
    expect(clippedValues).toEqual(['', '0', '']);
    const robustValues = featureParsedRows.map((columns) => featureValueAt(columns, 'z_robust'));
    expect(robustValues).toEqual(['', '0', '']);
    const hourlyValues = featureParsedRows.map((columns) => featureValueAt(columns, 'z_hourly'));
    expect(hourlyValues).toEqual(['', '0', '']);
    const logBurstMeanValues = featureParsedRows.map((columns) => featureValueAt(columns, 'log_burst_mean'));
    expect(logBurstMeanValues[0]).toBe('');
    expect(Number(logBurstMeanValues[1])).toBeCloseTo(Math.log(3.5), 6);
    expect(Number(logBurstMeanValues[2])).toBeCloseTo(Math.log(3.5), 6);
    const logBurstStdValues = featureParsedRows.map((columns) => featureValueAt(columns, 'log_burst_std'));
    expect(logBurstStdValues).toEqual(['', '0', '0']);
    const quantile25Values = featureParsedRows.map((columns) => featureValueAt(columns, 'm_q25'));
    expect(quantile25Values).toEqual(['', '3.5', '3.5']);
    const quantile75Values = featureParsedRows.map((columns) => featureValueAt(columns, 'm_q75'));
    expect(quantile75Values).toEqual(['', '3.5', '3.5']);
    const labelValues = featureParsedRows.map((columns) => featureValueAt(columns, 'time_label'));
    expect(labelValues).toEqual(['initial', 'measured', 'initial']);
    const sidFinalValues = featureParsedRows.map((columns) => featureValueAt(columns, CSV_TRAILING_COLUMN));
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
    expect(manifest.output.dir).toBe(tempDir);
    expect(manifest.output.csv_path).toBe(result.csvPath);
    expect(manifest.output.manifest_path).toBe(result.manifestPath);
    expect(manifest.output.csv_sha256).toBe(result.csvHash);
    expect(manifest.output.features_csv_path).toBe(result.featuresCsvPath);
    expect(manifest.output.features_csv_sha256).toBe(result.featuresCsvHash);
    expect(manifest.output).not.toHaveProperty('meta_path');
    expect(manifest.output).not.toHaveProperty('meta_sha256');
    expect(manifest.output.meta).toBeTruthy();
    if (!result.metaPath || !result.metaSha256) {
      throw new Error('metaPath and metaSha256 should be defined when meta records exist');
    }
    const expectedMetaRel = path.relative(tempDir, result.metaPath) || path.basename(result.metaPath);
    expect(manifest.output.meta).toEqual({ path: expectedMetaRel, sha256: result.metaSha256 });
    const metaContent = await fs.readFile(result.metaPath, 'utf8');
    const computedMetaSha = `sha256:${createHash('sha256').update(metaContent, 'utf8').digest('hex')}`;
    expect(result.metaSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.metaSha256).toBe(computedMetaSha);
    expect(manifest.output.meta.sha256).toBe(computedMetaSha);
    expect(manifest.output.run_meta_path).toBe(result.runMetaPath);
    expect(manifest.output.audit_path).toBe(result.auditPath);
    expect(manifest.output.schema_path).toBe(result.schemaPath);
    expect(manifest.output.fair_path).toBe(result.fairPath);
    expect(manifest.output.fair_sha256).toBe(result.fairSha256);
    expect(manifest.output.datasheet_path).toBe(result.datasheetPath);
    expect(manifest.output.datasheet_sha256).toBe(result.datasheetSha256);
    expect(manifest.output.provenance_path).toBe(result.provenancePath);
    expect(manifest.output.provenance_sha256).toBe(result.provenanceSha256);
    expect(manifest.schema_sha256).toBe(result.schemaSha256);
    expect(result.fairSha256).toHaveLength(64);
    expect(result.datasheetSha256).toHaveLength(64);
    expect(result.provenanceSha256).toHaveLength(64);
    expect(manifest.crypto).toEqual({
      kid: DEFAULT_CRYPTO_METADATA.kid,
      kdf: DEFAULT_CRYPTO_METADATA.kdf,
      info: DEFAULT_CRYPTO_METADATA.info,
      salt_b64: DEFAULT_CRYPTO_METADATA.salt_b64,
      keylen: DEFAULT_CRYPTO_METADATA.keylen,
      algo_ver: DEFAULT_CRYPTO_METADATA.algo_ver,
    });
    expect(manifest.source.sim_log_dir).toBe(tempDir);
    expect(manifest.timing).toMatchObject({
      epsilon_seconds: expect.any(Number),
      epsilon_t_seconds: expect.any(Number),
      timezone_offset_seconds: 0,
    });
    expect(manifest.timing.epsilon_seconds).toBeCloseTo(1e-2, 10);
    expect(manifest.timing.epsilon_t_seconds).toBeCloseTo(1e-2, 10);

    expect(manifest.features.include_features_csv).toBe(true);
    expect(manifest.features.columns).toEqual([
      ...CSV_BASE_COLUMNS,
      ...FEATURE_FILE_ADDITIONAL_COLUMNS,
      ...DEFAULT_FEATURE_COLUMNS,
      CSV_TRAILING_COLUMN,
    ]);
    expect(result.featureHeader).toEqual([
      ...CSV_BASE_COLUMNS,
      ...FEATURE_FILE_ADDITIONAL_COLUMNS,
      ...DEFAULT_FEATURE_COLUMNS,
      CSV_TRAILING_COLUMN,
    ]);
    expect(manifest.features.augmenter).toMatchObject({
      window_size: DEFAULT_FEATURE_AUGMENTER.windowSize,
      quantiles: DEFAULT_FEATURE_AUGMENTER.quantiles,
      clip_bounds: {
        z: { min: -5, max: 5 },
        z_robust: { min: -5, max: 5 },
        z_hourly: { min: -5, max: 5 },
        log_burst_z: { min: -5, max: 5 },
      },
    });
    expect(manifest.provenance.schema_version).toBeDefined();
    expect(manifest.jwt.allowed_issuers).toEqual(['https://issuer.example']);

    const fairPayload = JSON.parse(await fs.readFile(result.fairPath, 'utf8'));
    expect(fairPayload.dataset.csv_sha256).toBe(result.csvHash);
    expect(fairPayload.privacy.authorization_header_retained).toBe(false);

    const datasheetPayload = JSON.parse(await fs.readFile(result.datasheetPath, 'utf8'));
    expect(datasheetPayload.hashing.csv_sha256).toBe(result.csvHash);

    const provenancePayload = JSON.parse(await fs.readFile(result.provenancePath, 'utf8'));
    expect(provenancePayload.csv_sha256).toBe(result.csvHash);
    expect(provenancePayload.schema_version).toBeDefined();

    expect(result.runMetaPath).toBeDefined();
    const runMetaContent = await fs.readFile(result.runMetaPath, 'utf8');
    const runMeta = JSON.parse(runMetaContent);
    expect(runMeta.run_id).toBe(result.runId);
    expect(runMeta.algo_ver).toBe('sim-delta-v1');
    expect(runMeta.simulator_version).toMatch(/\d+\.\d+\.\d+/);
    expect(runMeta.seed).toBe('unit-seed');
    expect(runMeta.data_fingerprint.csv_sha256).toBe(result.csvHash);
    expect(runMeta.data_fingerprint.features_csv_sha256).toBe(result.featuresCsvHash);
    expect(runMeta.data_fingerprint.schema_sha256).toBe(result.schemaSha256);
    expect(runMeta.data_fingerprint.event_count).toBe(3);
    expect(runMeta.delta_t_generation.feature_window_size).toBe(DEFAULT_FEATURE_AUGMENTER.windowSize);
    expect(runMeta.injection_summary.anomaly_summary).toEqual({
      normal: 1,
      protocol_violation: 1,
      time_deviation: 1,
    });
    expect(runMeta.environment.node_version).toMatch(/^v\d+/);
    expect(runMeta.kid).toBe('KID-UNIT-001');
    expect(runMeta.crypto).toEqual({
      kid: DEFAULT_CRYPTO_METADATA.kid,
      kdf: 'hkdf-sha256',
      info: 'sid',
      salt_b64: '',
      keylen: 32,
      algo_ver: 'sid-hkdf-sha256-v1',
    });
    expect(/authorization|cookie|set-cookie|eyJ/i.test(runMetaContent)).toBe(false);

    expect(result.schemaPath).toBeDefined();
    const schemaContent = await fs.readFile(result.schemaPath, 'utf8');
    const schemaDoc = JSON.parse(schemaContent);
    expect(schemaDoc.$id).toBeDefined();
    expect(schemaDoc.version).toBe('1.0.0');
    expect(schemaDoc.raw_schema.columns).toHaveLength(10);
    expect(schemaDoc.features_schema.columns.length).toBe(
      CSV_BASE_COLUMNS.length + FEATURE_FILE_ADDITIONAL_COLUMNS.length + DEFAULT_FEATURE_COLUMNS.length + 1,
    );
    expect(schemaDoc.features_schema.quantiles).toEqual(DEFAULT_FEATURE_AUGMENTER.quantiles);

    expect(result.auditPath).toBeDefined();
    const auditLines = (await fs.readFile(result.auditPath, 'utf8')).trim().split('\n');
    expect(auditLines).toHaveLength(events.length);
    const firstAudit = JSON.parse(auditLines[0]);
    expect(firstAudit).toMatchObject({ idx: 0, sid_final: 'sess-001', anomaly_type: null });
    expect(firstAudit).not.toHaveProperty('uid');
    expect(firstAudit.params).toHaveProperty('delta_seconds');
    expect(result.auditRecordCount).toBe(auditLines.length);

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

  it('CSV ヘッダーは UTC 列のみを公開しローカル時刻列を含まない', async () => {
    const events = [
      {
        timestamp: '2024-06-01T09:00:00+09:00',
        timestamp_utc: '2024-06-01T00:00:00.000Z',
        session_id: 'sess-utc-only',
        user_id: 'user-utc-only',
        event: 'login',
        method: 'GET' as const,
        path: '/login',
        status: 200,
        latency_ms: 150,
        deltaSeconds: 1.25,
        metadata: { timezone_offset_seconds: 9 * 3600 },
      },
      {
        timestamp: '2024-06-01T09:00:02+09:00',
        timestamp_utc: '2024-06-01T00:00:02.000Z',
        session_id: 'sess-utc-only',
        user_id: 'user-utc-only',
        event: 'browse',
        method: 'GET' as const,
        path: '/resource',
        status: 200,
        latency_ms: 90,
        deltaSeconds: 2,
      },
    ];

    const result = await persistSimulationRun({
      events,
      scenarioId: 'default-flow',
      seed: 'utc-header',
      transitionTableVersion: 'v-test',
      runId: 'utc-header',
      outputDir: tempDir,
      kid: DEFAULT_CRYPTO_METADATA.kid,
      crypto: DEFAULT_CRYPTO_METADATA,
    });

    expect(result.featuresCsvPath).toBeNull();
    expect(result.featuresCsvHash).toBeNull();
    expect(result.featureHeader).toBeUndefined();

    const csvContent = await fs.readFile(result.csvPath, 'utf8');
    const header = csvContent.trim().split('\n', 1)[0]?.split(',') ?? [];
    const timestampColumns = header.filter((name) => name.startsWith('timestamp'));
    expect(timestampColumns).toEqual(['timestamp_utc']);
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
      includeFeaturesCsv: true,
      kid: DEFAULT_CRYPTO_METADATA.kid,
      crypto: DEFAULT_CRYPTO_METADATA,
    });

    const coarseResult = await persistSimulationRun({
      events: coarseEvents,
      runId: 'eps-coarse',
      outputDir: tempDir,
      parameters: { epsilon_t: 0.01 },
      includeFeaturesCsv: true,
      kid: DEFAULT_CRYPTO_METADATA.kid,
      crypto: DEFAULT_CRYPTO_METADATA,
    });

    const fineTiming = fineResult.manifest.timing as Record<string, number>;
    const coarseTiming = coarseResult.manifest.timing as Record<string, number>;
    expect(fineTiming.epsilon_seconds).toBeCloseTo(0.001, 10);
    expect(fineTiming.epsilon_t_seconds).toBeCloseTo(0.001, 10);
    expect(coarseTiming.epsilon_seconds).toBeCloseTo(0.003, 10);
    expect(coarseTiming.epsilon_t_seconds).toBeCloseTo(0.01, 10);

    if (!coarseResult.featuresCsvPath) {
      throw new Error('featuresCsvPath should be defined for coarseResult');
    }
    const coarseFeaturesCsv = await fs.readFile(coarseResult.featuresCsvPath, 'utf8');
    const coarseFeatureLines = coarseFeaturesCsv.trim().split('\n');
    const coarseFeatureHeader = coarseFeatureLines[0].split(',');
    const coarseFeatureIndex = new Map<string, number>();
    coarseFeatureHeader.forEach((name, index) => coarseFeatureIndex.set(name, index));
    const coarseFeatureRows = coarseFeatureLines.slice(1).map(parseCsvRow);
    const coarseLabels = coarseFeatureRows.map((columns) => columns[coarseFeatureIndex.get('time_label') ?? -1]);
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

    const result = await persistSimulationRun({
      events,
      runId: '  spaced run:id  ',
      outputDir: tempDir,
      kid: DEFAULT_CRYPTO_METADATA.kid,
      crypto: DEFAULT_CRYPTO_METADATA,
    });
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

  it('validateContractColumns が契約違反を検知する', () => {
    expect(() => validateContractColumns(new Array(CSV_BASE_COLUMNS.length).fill(null))).not.toThrow();
    expect(() => validateContractColumns(['only-one'])).toThrow('CSV contract violation');
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

    const csvLine = formatCsvAugmented(row as AugmentedSimulationEvent, DEFAULT_FEATURE_COLUMNS);
    const parsed = parseCsvRow(csvLine);
    expect(parsed).toHaveLength(CSV_BASE_COLUMNS.length);
    const index = (name: string): number => {
      const position = CSV_BASE_COLUMNS.indexOf(name as (typeof CSV_BASE_COLUMNS)[number]);
      if (position === -1) {
        throw new Error(`Column ${name} not found`);
      }
      return position;
    };
    expect(parsed[index('timestamp_utc')]).toBe('1719792000');
    expect(parsed[index('session_id')]).toBe('sess,comma');
    expect(parsed[index('method')]).toBe('POST');
    expect(parsed[index('path')]).toBe('/auth/login');
    expect(parsed[index('uid')]).toBe('null');
    expect(parsed[index('op_category')]).toBe('null');
  });
});
