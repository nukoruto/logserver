import type { SimulationEvent } from '../../services/simulationService';

export type FeatureResolver = (
  event: SimulationEvent,
  index: number,
  events: SimulationEvent[],
  fallback: number | string | null,
) => number | string | null;

export interface FeatureOverrides {
  dt_sec?: FeatureResolver;
  log_dt?: FeatureResolver;
  z?: FeatureResolver;
  z_clipped?: FeatureResolver;
  z_robust?: FeatureResolver;
  z_robust_clipped?: FeatureResolver;
  z_hourly?: FeatureResolver;
  z_hourly_clipped?: FeatureResolver;
  time_label?: FeatureResolver;
  log_burst_mean?: FeatureResolver;
  log_burst_std?: FeatureResolver;
  log_burst_z?: FeatureResolver;
  log_burst_z_clipped?: FeatureResolver;
  [key: string]: FeatureResolver | undefined;
}

export interface PersistSimulationInput extends Record<string, unknown> {
  events: readonly SimulationEvent[];
  scenarioId?: string;
  seed?: string | null;
  runId?: string | null;
  outputDir?: string;
  csvFileName?: string;
  featureCsvFileName?: string;
  manifestFileName?: string;
  metaFileName?: string;
  runMetaFileName?: string;
  auditFileName?: string;
  schemaFileName?: string;
  fairFileName?: string;
  datasheetFileName?: string;
  provenanceFileName?: string;
  parameters?: Record<string, unknown>;
  sessionIds?: readonly string[];
  featureOverrides?: FeatureOverrides;
  manifest?: Record<string, unknown>;
  transitionTableVersion?: string | null;
  extraMetadata?: Record<string, unknown>;
  includeFeaturesCsv?: boolean;
  kid?: string | null;
  crypto?: SessionCryptoMetadata | null;
  allowedIssuers?: readonly string[] | null;
}

export interface PersistSimulationResult {
  csvPath: string;
  featuresCsvPath: string | null;
  manifestPath: string;
  metaPath: string | null;
  metaSha256: string | null;
  runMetaPath: string;
  auditPath: string;
  schemaPath: string;
  fairPath: string;
  datasheetPath: string;
  provenancePath: string;
  runId: string;
  events: SimulationEvent[];
  manifest: Record<string, unknown>;
  csvHash: string;
  featuresCsvHash: string | null;
  schemaSha256: string;
  fairSha256: string;
  datasheetSha256: string;
  provenanceSha256: string;
  auditRecordCount: number;
  runMeta: RunMeta;
  featureHeader?: string[];
}

export function persistSimulationRun(input: PersistSimulationInput): Promise<PersistSimulationResult>;
export function summarizeDeltas(events: readonly SimulationEvent[]): Record<string, unknown>;
export function buildAnomalySummary(events: readonly SimulationEvent[]): Record<string, number>;

export interface AuditRecord {
  idx: number;
  sid_final: string | null;
  op_category: string | null;
  anomaly_type: string | null;
  reason: string | null;
  params: Record<string, number | string | null>;
}

export type AugmentedSimulationEvent = SimulationEvent & {
  dt_sec: number | null;
  log_dt: number | null;
  z: number | null;
  z_clipped: number | null;
  z_robust: number | null;
  z_robust_clipped: number | null;
  z_hourly: number | null;
  z_hourly_clipped: number | null;
  time_label: string | null;
  log_burst_mean: number | null;
  log_burst_std: number | null;
  log_burst_z: number | null;
  log_burst_z_clipped: number | null;
} & Record<string, unknown>;

export interface AugmentComputationOptions {
  epsilonT?: number;
  measurementEpsilon?: number;
  windowSize?: number;
  quantiles?: readonly number[];
  clipBounds?: Partial<Record<'z' | 'z_robust' | 'z_hourly' | 'log_burst_z', ClipBoundInput>>;
}

export type ClipBoundInput =
  | { min?: number; max?: number }
  | readonly [number, number]
  | number[]
  | number
  | null
  | undefined;

export interface FeatureAugmenterClipBounds {
  z: { min: number; max: number };
  z_robust: { min: number; max: number };
  z_hourly: { min: number; max: number };
  log_burst_z: { min: number; max: number };
}

export interface FeatureAugmenterOptions {
  windowSize: number;
  quantiles: number[];
  clipBounds: FeatureAugmenterClipBounds;
}

export interface SessionCryptoMetadata {
  kid: string;
  kdf: string;
  info: string;
  salt_b64: string;
  keylen: number;
  algo_ver: string;
}

export interface RunMeta {
  run_id: string;
  created_at_utc: string;
  algo_ver: string;
  simulator_version: string;
  seed: string | null;
  data_fingerprint: {
    csv_sha256: string;
    features_csv_sha256: string | null;
    schema_sha256: string;
    event_count: number;
    session_count: number;
  };
  delta_t_generation: {
    method: string;
    epsilon_seconds: number;
    epsilon_t_seconds: number;
    feature_window_size: number;
    feature_quantiles: number[];
    clip_bounds: FeatureAugmenterClipBounds;
  };
  injection_summary: {
    strategies: string[];
    anomaly_summary: Record<string, number>;
    anomaly_rate: number;
    anomaly_count: number | null;
    time_deviation: {
      method: string;
      quantile: number | null;
      threshold_seconds: number | null;
      vote_window: number;
      vote_threshold: number;
      hysteresis_hold: number;
    };
  };
  environment: {
    node_version: string;
    platform: string;
    arch: string;
    env: string;
    gpu_mode: string | null;
  };
  kid: string | null;
  crypto: SessionCryptoMetadata;
}

export function augmentRows<T extends SimulationEvent>(
  rows: readonly T[],
  extras?: FeatureOverrides,
  options?: AugmentComputationOptions,
): Array<T & AugmentedSimulationEvent>;
export function formatCsvAugmented(
  event: AugmentedSimulationEvent,
  featureColumns: readonly string[],
): string;
export function validateContractColumns(columns: readonly unknown[]): void;

export const DEFAULT_FEATURE_AUGMENTER: FeatureAugmenterOptions;
export function resolveFeatureAugmenterOptions(
  input?: Partial<FeatureAugmenterOptions> | Record<string, unknown>,
): FeatureAugmenterOptions;
export function cloneFeatureAugmenterOptions(options: FeatureAugmenterOptions): FeatureAugmenterOptions;

export function appendAudit(
  filePath: string,
  records: readonly AuditRecord[],
  options?: { truncate?: boolean },
): Promise<number>;

export function buildRunMeta(input: {
  runId: string;
  createdAtUtc: string;
  seed: string | null;
  csvHash: string;
  featuresCsvHash: string | null;
  schemaSha256: string;
  eventCount: number;
  sessionCount: number;
  measurementEpsilon: number;
  epsilonT: number;
  featureAugmenter: FeatureAugmenterOptions;
  anomalySummary: Record<string, number>;
  strategies: readonly string[];
  anomalyRate: number;
  anomalyCount: number | null;
  timeDeviation: {
    method: string;
    quantile: number | null;
    thresholdSeconds: number | null;
    voteWindow: number;
    voteThreshold: number;
    hysteresisHold: number;
  };
  env: string;
  gpuMode: string | null;
  kid: string | null;
  crypto: SessionCryptoMetadata;
}): RunMeta;

declare const simWriter: {
  persistSimulationRun: typeof persistSimulationRun;
  summarizeDeltas: typeof summarizeDeltas;
  buildAnomalySummary: typeof buildAnomalySummary;
  augmentRows: typeof augmentRows;
  formatCsvAugmented: typeof formatCsvAugmented;
  validateContractColumns: typeof validateContractColumns;
  appendAudit: typeof appendAudit;
  buildRunMeta: typeof buildRunMeta;
};

export {
  augmentRows,
  appendAudit,
  buildAnomalySummary,
  buildRunMeta,
  formatCsvAugmented,
  persistSimulationRun,
  summarizeDeltas,
  validateContractColumns,
};
export default simWriter;
