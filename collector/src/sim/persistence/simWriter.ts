import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import packageJson from '../../../package.json';
import config from '../../config';
import { labelSequence } from '../labeler';
import type { SimulationEvent } from '../../services/simulationService';

const DEFAULT_TIME_ANOMALY_PROPAGATE_WEIGHT = 0.7;
const SIMULATOR_VERSION = typeof packageJson.version === 'string' && packageJson.version.length > 0
  ? packageJson.version
  : '0.0.0';
const SIMULATOR_ALGO_VERSION = 'sim-delta-v1';
const DEFAULT_RUN_META_FILE = 'run_meta.json';
const DEFAULT_AUDIT_FILE = 'audit.jsonl';
const DEFAULT_SCHEMA_FILE = 'schema.json';
const DEFAULT_FAIR_FILE = 'fair.json';
const DEFAULT_DATASHEET_FILE = 'datasheet.json';
const DEFAULT_PROVENANCE_FILE = 'provenance.json';
const SCHEMA_VERSION = '1.0.0';
const SCHEMA_ID = 'https://logserver.dev/schemas/session-run/1-0-0';
const DEFAULT_DATASET_KEY_LENGTH = 32;
const DEFAULT_CRYPTO_ALGO_VERSION = 'sid-hkdf-sha256-v1';
const RFC3339_UTC_PATTERN =
  '^(?:[0-9]{4}-[0-9]{2}-[0-9]{2})T(?:[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.[0-9]{1,3})?Z$';

type RawSchemaColumn = {
  name: string;
  type: 'string' | 'number' | 'integer';
  pattern?: string;
  description: string;
};

type FeatureSchemaColumn = {
  name: string;
  type: 'string' | 'number' | 'integer';
  unit: string | null;
  description: string;
};

const RAW_SCHEMA_COLUMNS: RawSchemaColumn[] = [
  {
    name: 'timestamp_utc',
    type: 'string',
    pattern: RFC3339_UTC_PATTERN,
    description: 'Event timestamp in UTC (RFC 3339)',
  },
  {
    name: 'session_id',
    type: 'string',
    description: 'Deterministic session identifier',
  },
  {
    name: 'uid',
    type: 'string',
    description: 'HKDF-HMAC pseudonymised user identifier',
  },
  { name: 'method', type: 'string', description: 'HTTP method verb' },
  { name: 'path', type: 'string', description: 'HTTP resource path' },
  { name: 'referer', type: 'string', description: 'HTTP referer header' },
  { name: 'user_agent', type: 'string', description: 'HTTP user-agent header' },
  { name: 'ip', type: 'string', description: 'Client IP (documentation range)' },
  { name: 'cookie', type: 'string', description: 'HTTP cookie header (pseudonymised)' },
  {
    name: 'op_category',
    type: 'string',
    description: 'Operation category (AUTH/READ/UPDATE)',
  },
];

const FEATURE_COLUMN_DEFINITIONS: Record<string, FeatureSchemaColumn> = {
  timestamp_utc: {
    name: 'timestamp_utc',
    type: 'string',
    unit: 'rfc3339',
    description: 'Event timestamp in UTC (RFC 3339)',
  },
  session_id: {
    name: 'session_id',
    type: 'string',
    unit: 'identifier',
    description: 'Deterministic session identifier',
  },
  uid: {
    name: 'uid',
    type: 'string',
    unit: 'identifier',
    description: 'HKDF-HMAC pseudonymised user identifier',
  },
  method: {
    name: 'method',
    type: 'string',
    unit: 'http_method',
    description: 'HTTP method verb',
  },
  path: {
    name: 'path',
    type: 'string',
    unit: 'uri_path',
    description: 'HTTP resource path',
  },
  referer: {
    name: 'referer',
    type: 'string',
    unit: 'uri',
    description: 'HTTP referer header',
  },
  user_agent: {
    name: 'user_agent',
    type: 'string',
    unit: 'user_agent',
    description: 'HTTP user-agent header',
  },
  ip: {
    name: 'ip',
    type: 'string',
    unit: 'ip_address',
    description: 'Client IP (documentation range)',
  },
  cookie: {
    name: 'cookie',
    type: 'string',
    unit: 'cookie_header',
    description: 'HTTP cookie header (pseudonymised)',
  },
  op_category: {
    name: 'op_category',
    type: 'string',
    unit: 'operation_category',
    description: 'Operation category (AUTH/READ/UPDATE)',
  },
  user_id: { name: 'user_id', type: 'string', unit: null, description: 'Original user identifier (if provided)' },
  event: { name: 'event', type: 'string', unit: null, description: 'Logical event label' },
  status_code: { name: 'status_code', type: 'integer', unit: null, description: 'HTTP status code' },
  latency_ms: { name: 'latency_ms', type: 'number', unit: 'milliseconds', description: 'Response latency' },
  delta_t: { name: 'delta_t', type: 'number', unit: 'seconds', description: 'Measured delta between events' },
  metadata: { name: 'metadata', type: 'string', unit: null, description: 'JSON metadata blob' },
  dt_sec: { name: 'dt_sec', type: 'number', unit: 'seconds', description: 'Δt in seconds (post-processed)' },
  log_dt: { name: 'log_dt', type: 'number', unit: null, description: 'Logarithm of Δt' },
  z: { name: 'z', type: 'number', unit: 'z-score', description: 'Standard score of Δt' },
  z_clipped: { name: 'z_clipped', type: 'number', unit: 'z-score', description: 'Clipped z-score of Δt' },
  z_robust: { name: 'z_robust', type: 'number', unit: 'z-score', description: 'Robust z-score (MAD scaled)' },
  z_robust_clipped: {
    name: 'z_robust_clipped',
    type: 'number',
    unit: 'z-score',
    description: 'Clipped robust z-score',
  },
  z_hourly: { name: 'z_hourly', type: 'number', unit: 'z-score', description: 'Hourly z-score baseline' },
  z_hourly_clipped: {
    name: 'z_hourly_clipped',
    type: 'number',
    unit: 'z-score',
    description: 'Clipped hourly z-score',
  },
  time_label: { name: 'time_label', type: 'string', unit: null, description: 'Δt classification (initial/measured)' },
  log_burst_mean: {
    name: 'log_burst_mean',
    type: 'number',
    unit: null,
    description: 'Rolling log Δt mean',
  },
  log_burst_std: {
    name: 'log_burst_std',
    type: 'number',
    unit: null,
    description: 'Rolling log Δt standard deviation',
  },
  log_burst_z: {
    name: 'log_burst_z',
    type: 'number',
    unit: 'z-score',
    description: 'Z-score within log Δt burst window',
  },
  log_burst_z_clipped: {
    name: 'log_burst_z_clipped',
    type: 'number',
    unit: 'z-score',
    description: 'Clipped log Δt burst z-score',
  },
  sid_final: { name: 'sid_final', type: 'string', unit: null, description: 'Final session identifier after reconciliation' },
};

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
}

export interface PersistSimulationResult {
  csvPath: string;
  featuresCsvPath: string | null;
  manifestPath: string;
  metaPath: string | null;
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

export interface FeatureAugmenterClipBounds {
  z: ClipBounds;
  z_robust: ClipBounds;
  z_hourly: ClipBounds;
  log_burst_z: ClipBounds;
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

export interface AuditRecord {
  idx: number;
  sid_final: string | null;
  op_category: string | null;
  anomaly_type: string | null;
  reason: string | null;
  params: Record<string, number | string | null>;
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

export type ClipBoundInput =
  | { min?: number; max?: number }
  | readonly [number, number]
  | number[]
  | number
  | null
  | undefined;

interface ClipBounds {
  min: number;
  max: number;
}

const EPSILON_MIN = 1e-6;
const EPSILON_MAX = 1e-2;
const GLOBAL_SESSION_KEY = '__global__';
const DEFAULT_WINDOW_SIZE = 12;
const DEFAULT_QUANTILES = Object.freeze([0.25, 0.5, 0.75]);
const MAD_TO_STD = 1.4826;
const DEFAULT_CLIP_BOUNDS: FeatureAugmenterClipBounds = {
  z: { min: -5, max: 5 },
  z_robust: { min: -5, max: 5 },
  z_hourly: { min: -5, max: 5 },
  log_burst_z: { min: -5, max: 5 },
};

const BASE_EXTRA_COLUMN_NAMES = [
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
] as const;

const hasOwn = Object.prototype.hasOwnProperty;

const clamp = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
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

const cloneClipBounds = (bounds: ClipBounds): ClipBounds => ({ min: bounds.min, max: bounds.max });

const sanitizeClipTuple = (value: ClipBoundInput): ClipBounds | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const absolute = Math.abs(value);
    if (absolute === 0) {
      return null;
    }
    return { min: -absolute, max: absolute };
  }
  if (Array.isArray(value)) {
    const [first, second] = value;
    const min = Number(first);
    const max = Number(second);
    if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
      return { min, max };
    }
  }
  if (value && typeof value === 'object') {
    const candidateMin = Number((value as { min?: number }).min);
    const candidateMax = Number((value as { max?: number }).max);
    if (Number.isFinite(candidateMin) && Number.isFinite(candidateMax) && candidateMin < candidateMax) {
      return { min: candidateMin, max: candidateMax };
    }
  }
  return null;
};

const resolveClipBounds = (
  input?: Partial<Record<'z' | 'z_robust' | 'z_hourly' | 'log_burst_z', ClipBoundInput>>,
): FeatureAugmenterClipBounds => ({
  z: sanitizeClipTuple(input?.z) ?? cloneClipBounds(DEFAULT_CLIP_BOUNDS.z),
  z_robust: sanitizeClipTuple(input?.z_robust) ?? cloneClipBounds(DEFAULT_CLIP_BOUNDS.z_robust),
  z_hourly: sanitizeClipTuple(input?.z_hourly) ?? cloneClipBounds(DEFAULT_CLIP_BOUNDS.z_hourly),
  log_burst_z: sanitizeClipTuple(input?.log_burst_z) ?? cloneClipBounds(DEFAULT_CLIP_BOUNDS.log_burst_z),
});

const resolveWindowSize = (value: unknown): number => {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric;
  }
  return DEFAULT_WINDOW_SIZE;
};

const sanitizeQuantiles = (quantiles?: readonly number[]): number[] => {
  if (!Array.isArray(quantiles)) {
    return [...DEFAULT_QUANTILES];
  }
  const filtered = quantiles
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => {
      if (value < 0) {
        return 0;
      }
      if (value > 1) {
        return 1;
      }
      return value;
    });
  const unique = Array.from(new Set(filtered));
  if (unique.length === 0) {
    return [...DEFAULT_QUANTILES];
  }
  unique.sort((a, b) => a - b);
  return unique;
};

const quantileColumnName = (quantile: number): string => {
  const percent = quantile * 100;
  const normalized = Number.isFinite(percent)
    ? percent.toFixed(2).replace(/\.0+$/, '').replace('.', 'p')
    : '0';
  return `m_q${normalized}`;
};

const computeMedian = (values: readonly number[]): number | null => {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
};

const computeMad = (values: readonly number[], median: number | null): number => {
  if (median === null) {
    return 0;
  }
  const deviations = values.map((value) => Math.abs(value - median));
  const mad = computeMedian(deviations);
  return mad !== null ? mad : 0;
};

const computeQuantile = (sortedValues: readonly number[], quantile: number): number => {
  if (sortedValues.length === 0) {
    return Number.NaN;
  }
  if (quantile <= 0) {
    return sortedValues[0];
  }
  if (quantile >= 1) {
    return sortedValues[sortedValues.length - 1];
  }
  const position = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];
  if (lowerIndex === upperIndex) {
    return lowerValue;
  }
  const weight = position - lowerIndex;
  return lowerValue * (1 - weight) + upperValue * weight;
};

export const DEFAULT_FEATURE_AUGMENTER: FeatureAugmenterOptions = {
  windowSize: DEFAULT_WINDOW_SIZE,
  quantiles: [...DEFAULT_QUANTILES],
  clipBounds: {
    z: cloneClipBounds(DEFAULT_CLIP_BOUNDS.z),
    z_robust: cloneClipBounds(DEFAULT_CLIP_BOUNDS.z_robust),
    z_hourly: cloneClipBounds(DEFAULT_CLIP_BOUNDS.z_hourly),
    log_burst_z: cloneClipBounds(DEFAULT_CLIP_BOUNDS.log_burst_z),
  },
};

export const resolveFeatureAugmenterOptions = (
  input?: Partial<FeatureAugmenterOptions> | Record<string, unknown>,
): FeatureAugmenterOptions => {
  const windowSizeCandidate = (input as Record<string, unknown>)?.windowSize
    ?? (input as Record<string, unknown>)?.window_size;
  const quantilesCandidate = (input as Record<string, unknown>)?.quantiles;
  const clipCandidate = (input as Record<string, unknown>)?.clipBounds
    ?? (input as Record<string, unknown>)?.clip_bounds;
  const sanitizedQuantiles = sanitizeQuantiles(
    Array.isArray(quantilesCandidate) ? (quantilesCandidate as number[]) : undefined,
  );
  const resolvedClipBounds = resolveClipBounds(
    clipCandidate as Partial<Record<'z' | 'z_robust' | 'z_hourly' | 'log_burst_z', ClipBoundInput>> | undefined,
  );
  return {
    windowSize: resolveWindowSize(windowSizeCandidate),
    quantiles: sanitizedQuantiles,
    clipBounds: resolvedClipBounds,
  };
};

const resolveFeatureAugmenterFromInput = (
  input: PersistSimulationInput | null | undefined,
): FeatureAugmenterOptions => {
  const parameters = (input?.parameters ?? {}) as Record<string, unknown>;
  const parameterAugmenter = parameters.feature_augmenter ?? parameters.featureAugmenter;
  if (parameterAugmenter && typeof parameterAugmenter === 'object') {
    return resolveFeatureAugmenterOptions(parameterAugmenter as Record<string, unknown>);
  }
  const manifest = (input?.manifest ?? {}) as Record<string, unknown>;
  const manifestFeatures = (manifest.features ?? {}) as Record<string, unknown>;
  const manifestAugmenter = manifestFeatures.augmenter;
  if (manifestAugmenter && typeof manifestAugmenter === 'object') {
    return resolveFeatureAugmenterOptions(manifestAugmenter as Record<string, unknown>);
  }
  return cloneFeatureAugmenterOptions(DEFAULT_FEATURE_AUGMENTER);
};

const sanitizeNumeric = (value: unknown): number | null => {
  if (typeof value !== 'number') {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
};

const parseTimestamp = (value: unknown): Date | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

const estimateMeasurementEpsilon = (events: readonly SimulationEvent[]): number => {
  let minPositive = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const delta = extractDeltaSeconds(event);
    if (typeof delta === 'number' && Number.isFinite(delta) && delta > 0) {
      if (delta < minPositive) {
        minPositive = delta;
      }
    }
  }
  if (!Number.isFinite(minPositive)) {
    return EPSILON_MIN;
  }
  const candidate = 0.5 * minPositive;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return EPSILON_MIN;
  }
  const clamped = Math.min(Math.max(candidate, EPSILON_MIN), EPSILON_MAX);
  return clamped;
};

const extractNumeric = (value: unknown): number | null => {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return null;
};

const toFiniteNumber = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const resolveEpsilonT = (input: PersistSimulationInput | null | undefined, epsilon: number): number => {
  const parameters = (input?.parameters ?? {}) as Record<string, unknown>;
  const candidate = extractNumeric(parameters.epsilon_t ?? parameters.epsilonT);
  if (candidate !== null && candidate >= 0) {
    return candidate;
  }
  const manifest = (input?.manifest ?? {}) as Record<string, unknown>;
  const timing = (manifest.timing ?? {}) as Record<string, unknown>;
  const manifestCandidate = extractNumeric(timing.epsilon_t_seconds ?? timing.epsilonT);
  if (manifestCandidate !== null && manifestCandidate >= 0) {
    return manifestCandidate;
  }
  return epsilon;
};

const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/;

const parseOffsetFromTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.trim().match(OFFSET_PATTERN);
  if (!match) {
    return null;
  }
  const token = match[1];
  if (token === 'Z') {
    return 0;
  }
  const sign = token.startsWith('-') ? -1 : 1;
  const digits = token.replace(/[+\-]/, '').replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2) || '0');
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }
  return sign * (hours * 60 + minutes);
};

const resolveTimezoneOffsetSeconds = (events: readonly SimulationEvent[]): number => {
  for (const event of events) {
    const metadata = (event?.metadata ?? {}) as Record<string, unknown>;
    const direct = extractNumeric(metadata.timezone_offset_seconds);
    if (direct !== null) {
      return direct;
    }
    const nestedTiming = (metadata.timing ?? {}) as Record<string, unknown>;
    const nested = extractNumeric(nestedTiming.timezone_offset_seconds);
    if (nested !== null) {
      return nested;
    }
    const timestampOffset = parseOffsetFromTimestamp(event.timestamp || event.timestamp_utc);
    if (timestampOffset !== null) {
      return timestampOffset * 60;
    }
  }
  return 0;
};

const computeMeanAndStd = (values: readonly number[]): { mean: number; std: number } => {
  if (!Array.isArray(values) || values.length === 0) {
    return { mean: 0, std: 0 };
  }
  const count = values.length;
  const sum = values.reduce((acc, value) => acc + value, 0);
  const mean = sum / count;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / count;
  const std = Number.isFinite(variance) && variance > 0 ? Math.sqrt(variance) : 0;
  return { mean, std };
};

const normalizeTimeLabel = (value: unknown): 'initial' | 'measured' | 'unknown' => {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'initial') {
    return 'initial';
  }
  if (normalized === 'measured' || normalized === 'ok') {
    return 'measured';
  }
  return 'unknown';
};

const baseExtrasResolvers: Record<string, FeatureResolver | null> = BASE_EXTRA_COLUMN_NAMES.reduce(
  (accumulator, column) => {
    accumulator[column] = null;
    return accumulator;
  },
  {} as Record<string, FeatureResolver | null>,
);

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
] as const;

const FEATURE_ADDITIONAL_COLUMNS = [
  'user_id',
  'event',
  'status_code',
  'latency_ms',
  'delta_t',
  'metadata',
] as const;

const CSV_TRAILING_COLUMNS = ['sid_final'] as const;

export const validateContractColumns = (columns: readonly unknown[]): void => {
  if (columns.length !== CSV_BASE_COLUMNS.length) {
    throw new Error(
      `CSV contract violation: expected ${CSV_BASE_COLUMNS.length} columns but received ${columns.length}`,
    );
  }
};

const buildFeatureColumnList = (options: FeatureAugmenterOptions): string[] => [
  ...BASE_EXTRA_COLUMN_NAMES,
  ...options.quantiles.map((quantile) => quantileColumnName(quantile)),
];

export const cloneFeatureAugmenterOptions = (options: FeatureAugmenterOptions): FeatureAugmenterOptions => ({
  windowSize: options.windowSize,
  quantiles: [...options.quantiles],
  clipBounds: {
    z: cloneClipBounds(options.clipBounds.z),
    z_robust: cloneClipBounds(options.clipBounds.z_robust),
    z_hourly: cloneClipBounds(options.clipBounds.z_hourly),
    log_burst_z: cloneClipBounds(options.clipBounds.log_burst_z),
  },
});

export const augmentRows = <T extends SimulationEvent>(
  rows: readonly T[],
  extras: FeatureOverrides = {},
  options: AugmentComputationOptions = {},
): Array<T & AugmentedSimulationEvent> => {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const featureOptions = resolveFeatureAugmenterOptions(options as Record<string, unknown>);
  const quantileColumns = featureOptions.quantiles.map((quantile) => quantileColumnName(quantile));

  const resolvers: Record<string, FeatureResolver | null> = { ...baseExtrasResolvers };
  for (const column of quantileColumns) {
    resolvers[column] = null;
  }

  for (const column of Object.keys(resolvers)) {
    const resolver = extras[column];
    if (resolver !== undefined && typeof resolver !== 'function') {
      throw new TypeError(`${column} override must be a function when provided`);
    }
    if (resolver !== undefined) {
      resolvers[column] = resolver ?? null;
    }
  }

  const sanitizedRows = rows.map((event) =>
    event && typeof event === 'object' ? ({ ...event } as SimulationEvent) : ({}) as SimulationEvent,
  );

  const suppliedMeasurementEpsilon = options.measurementEpsilon;
  const measurementEpsilon = typeof suppliedMeasurementEpsilon === 'number' && suppliedMeasurementEpsilon > 0
    ? Math.min(Math.max(suppliedMeasurementEpsilon, EPSILON_MIN), EPSILON_MAX)
    : estimateMeasurementEpsilon(sanitizedRows);
  const suppliedEpsilonT = options.epsilonT;
  const epsilonT = typeof suppliedEpsilonT === 'number' && suppliedEpsilonT >= 0
    ? suppliedEpsilonT
    : measurementEpsilon;

  const sessionStates = new Map<string, { previousTimestamp: number | null; sequence: number }>();
  const dtValues: Array<number | null> = new Array(sanitizedRows.length).fill(null);
  const timeLabels: Array<'initial' | 'measured' | 'unknown'> = new Array(sanitizedRows.length).fill('unknown');
  const eventHours: Array<number | null> = new Array(sanitizedRows.length).fill(null);
  const hourlyBuckets = new Map<number, number[]>();

  for (let index = 0; index < sanitizedRows.length; index += 1) {
    const event = sanitizedRows[index];
    const resolver = resolvers.dt_sec;
    const fallbackDelta = sanitizeNumeric(extractDeltaSeconds(event));
    const resolvedDelta = resolver
      ? sanitizeNumeric(resolver(event, index, sanitizedRows, fallbackDelta))
      : fallbackDelta;
    const sessionId = typeof event.session_id === 'string' && event.session_id.trim().length > 0
      ? event.session_id
      : GLOBAL_SESSION_KEY;
    const timestamp = parseTimestamp(event.timestamp || event.timestamp_utc);
    const state = sessionStates.get(sessionId) || { previousTimestamp: null, sequence: 0 };
    eventHours[index] = timestamp ? timestamp.getUTCHours() : null;

    let dtSec: number | null = resolvedDelta !== null && resolvedDelta > 0 ? resolvedDelta : null;
    let label: 'initial' | 'measured' | 'unknown';

    if (!timestamp) {
      label = 'initial';
      state.previousTimestamp = null;
    } else if (state.sequence === 0 || state.previousTimestamp === null) {
      label = 'initial';
      dtSec = null;
      state.previousTimestamp = timestamp.getTime();
    } else {
      let deltaCandidate = dtSec;
      if (deltaCandidate === null) {
        const diffSeconds = (timestamp.getTime() - state.previousTimestamp) / 1000;
        if (Number.isFinite(diffSeconds) && diffSeconds >= 0) {
          deltaCandidate = diffSeconds;
        }
      }
      if (deltaCandidate === null || !Number.isFinite(deltaCandidate) || deltaCandidate < 0) {
        label = 'initial';
        dtSec = null;
        state.previousTimestamp = timestamp.getTime();
      } else {
        const adjusted = Math.max(deltaCandidate, measurementEpsilon);
        dtSec = adjusted;
        label = adjusted <= epsilonT ? 'unknown' : 'measured';
        state.previousTimestamp = timestamp.getTime();
      }
    }

    dtValues[index] = dtSec;
    timeLabels[index] = label;
    (event as Record<string, unknown>).deltaSeconds = dtSec;
    state.sequence += 1;
    sessionStates.set(sessionId, state);

    if (dtSec !== null && eventHours[index] !== null) {
      const hour = eventHours[index] as number;
      const bucket = hourlyBuckets.get(hour) ?? [];
      bucket.push(dtSec);
      hourlyBuckets.set(hour, bucket);
    }
  }

  const positiveDtValues = dtValues.filter((value): value is number => value !== null);
  const { mean, std } = computeMeanAndStd(positiveDtValues);
  const globalMedian = computeMedian(positiveDtValues);
  const globalMad = computeMad(positiveDtValues, globalMedian);

  const hourlyStats = new Map<number, { median: number; mad: number; mean: number; std: number }>();
  for (const [hour, values] of hourlyBuckets.entries()) {
    const { mean: hourMean, std: hourStd } = computeMeanAndStd(values);
    const hourMedian = computeMedian(values);
    const hourMad = computeMad(values, hourMedian);
    hourlyStats.set(hour, {
      median: hourMedian ?? 0,
      mad: hourMad,
      mean: hourMean,
      std: hourStd,
    });
  }

  const dtWindow: number[] = [];
  const logWindow: number[] = [];

  return sanitizedRows.map((event, index) => {
    const dtSec = dtValues[index];
    const logFallback = dtSec !== null && dtSec > 0 ? Math.log(dtSec) : null;
    const logResolver = resolvers.log_dt;
    const logDt = logResolver
      ? sanitizeNumeric(logResolver(event, index, sanitizedRows, logFallback)) ?? logFallback
      : logFallback;

    let zScore: number | null = null;
    if (dtSec !== null) {
      zScore = std > 0 ? (dtSec - mean) / std : 0;
    }
    const zResolver = resolvers.z;
    if (zResolver) {
      const override = zResolver(event, index, sanitizedRows, zScore);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        zScore = numeric;
      }
    }

    const zClipBounds = featureOptions.clipBounds.z;
    const clippedFallback = zScore === null ? null : clamp(zScore, zClipBounds.min, zClipBounds.max);
    const zClippedResolver = resolvers.z_clipped;
    const zClipped = zClippedResolver
      ? sanitizeNumeric(zClippedResolver(event, index, sanitizedRows, clippedFallback)) ?? clippedFallback
      : clippedFallback;

    let robustZ: number | null = null;
    if (dtSec !== null) {
      if (globalMedian !== null && globalMad > 0) {
        robustZ = (0.6744897501960817 * (dtSec - globalMedian)) / globalMad;
      } else if (globalMedian !== null) {
        robustZ = dtSec === globalMedian ? 0 : Math.sign(dtSec - globalMedian);
      }
    }
    const zRobustResolver = resolvers.z_robust;
    if (zRobustResolver) {
      const override = zRobustResolver(event, index, sanitizedRows, robustZ);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        robustZ = numeric;
      }
    }
    const robustClip = featureOptions.clipBounds.z_robust;
    const robustClippedFallback = robustZ === null ? null : clamp(robustZ, robustClip.min, robustClip.max);
    const zRobustClippedResolver = resolvers.z_robust_clipped;
    const zRobustClipped = zRobustClippedResolver
      ? sanitizeNumeric(zRobustClippedResolver(event, index, sanitizedRows, robustClippedFallback))
        ?? robustClippedFallback
      : robustClippedFallback;

    let hourlyZ: number | null = null;
    if (dtSec !== null && eventHours[index] !== null) {
      const stats = hourlyStats.get(eventHours[index] as number);
      if (stats) {
        const baseline = Number.isFinite(stats.median) ? stats.median : stats.mean;
        const denominator = stats.std > 0 ? stats.std : stats.mad > 0 ? stats.mad * MAD_TO_STD : 0;
        if (baseline !== undefined && Number.isFinite(baseline)) {
          if (denominator > 0) {
            hourlyZ = (dtSec - baseline) / denominator;
          } else {
            hourlyZ = dtSec === baseline ? 0 : Math.sign(dtSec - baseline);
          }
        }
      }
    }
    const zHourlyResolver = resolvers.z_hourly;
    if (zHourlyResolver) {
      const override = zHourlyResolver(event, index, sanitizedRows, hourlyZ);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        hourlyZ = numeric;
      }
    }
    const hourlyClip = featureOptions.clipBounds.z_hourly;
    const hourlyClippedFallback = hourlyZ === null ? null : clamp(hourlyZ, hourlyClip.min, hourlyClip.max);
    const zHourlyClippedResolver = resolvers.z_hourly_clipped;
    const zHourlyClipped = zHourlyClippedResolver
      ? sanitizeNumeric(zHourlyClippedResolver(event, index, sanitizedRows, hourlyClippedFallback))
        ?? hourlyClippedFallback
      : hourlyClippedFallback;

    if (dtSec !== null) {
      dtWindow.push(dtSec);
      if (dtWindow.length > featureOptions.windowSize) {
        dtWindow.shift();
      }
      const logValue = Math.log(Math.max(dtSec, measurementEpsilon));
      logWindow.push(logValue);
      if (logWindow.length > featureOptions.windowSize) {
        logWindow.shift();
      }
    }

    const sortedWindow = dtWindow.length > 0 ? [...dtWindow].sort((a, b) => a - b) : [];
    const quantileValues: Record<string, number | null> = {};
    for (let qIndex = 0; qIndex < quantileColumns.length; qIndex += 1) {
      const column = quantileColumns[qIndex];
      const quantile = featureOptions.quantiles[qIndex];
      const fallback = sortedWindow.length > 0 ? computeQuantile(sortedWindow, quantile) : null;
      const resolver = resolvers[column];
      const resolved = resolver
        ? sanitizeNumeric(resolver(event, index, sanitizedRows, fallback)) ?? fallback
        : fallback;
      quantileValues[column] = resolved;
    }

    let logBurstMean: number | null = null;
    let logBurstStd: number | null = null;
    let logBurstZ: number | null = null;
    if (logWindow.length > 0) {
      const { mean: windowLogMean, std: windowLogStd } = computeMeanAndStd(logWindow);
      logBurstMean = windowLogMean;
      logBurstStd = logWindow.length > 1 ? windowLogStd : 0;
      if (logDt !== null) {
        if (windowLogStd > 0) {
          logBurstZ = (logDt - windowLogMean) / windowLogStd;
        } else {
          logBurstZ = logDt === windowLogMean ? 0 : Math.sign(logDt - windowLogMean);
        }
      }
    }

    const logBurstMeanResolver = resolvers.log_burst_mean;
    if (logBurstMeanResolver) {
      const override = logBurstMeanResolver(event, index, sanitizedRows, logBurstMean);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        logBurstMean = numeric;
      }
    }

    const logBurstStdResolver = resolvers.log_burst_std;
    if (logBurstStdResolver) {
      const override = logBurstStdResolver(event, index, sanitizedRows, logBurstStd);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        logBurstStd = numeric;
      }
    }

    const logBurstZResolver = resolvers.log_burst_z;
    if (logBurstZResolver) {
      const override = logBurstZResolver(event, index, sanitizedRows, logBurstZ);
      const numeric = sanitizeNumeric(override);
      if (numeric !== null) {
        logBurstZ = numeric;
      }
    }

    const logBurstClip = featureOptions.clipBounds.log_burst_z;
    const logBurstClippedFallback = logBurstZ === null ? null : clamp(logBurstZ, logBurstClip.min, logBurstClip.max);
    const logBurstZClippedResolver = resolvers.log_burst_z_clipped;
    const logBurstZClipped = logBurstZClippedResolver
      ? sanitizeNumeric(logBurstZClippedResolver(event, index, sanitizedRows, logBurstClippedFallback))
        ?? logBurstClippedFallback
      : logBurstClippedFallback;

    const labelFallback = timeLabels[index] ?? 'unknown';
    const labelResolver = resolvers.time_label;
    const labelOverride = labelResolver
      ? labelResolver(event, index, sanitizedRows, labelFallback)
      : null;
    const timeLabel = normalizeTimeLabel(labelOverride ?? labelFallback);

    return {
      ...(event as Record<string, unknown>),
      dt_sec: dtSec,
      log_dt: logDt,
      z: zScore,
      z_clipped: zClipped,
      z_robust: robustZ,
      z_robust_clipped: zRobustClipped,
      z_hourly: hourlyZ,
      z_hourly_clipped: zHourlyClipped,
      time_label: timeLabel,
      log_burst_mean: logBurstMean,
      log_burst_std: logBurstStd,
      log_burst_z: logBurstZ,
      log_burst_z_clipped: logBurstZClipped,
      ...quantileValues,
    } as T & AugmentedSimulationEvent;
  });
};

const toCsvField = (value: unknown): string => {
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

const sanitizeRunId = (runId: unknown): string | null => {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return null;
  }
  const trimmed = runId.trim();
  return trimmed.replace(/[^a-zA-Z0-9_-]+/g, '-');
};

const sanitizeKid = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 64);
};

const sanitizeCryptoMetadata = (
  value: SessionCryptoMetadata | null | undefined,
  fallbackKid: string | null,
): SessionCryptoMetadata => {
  const source = value && typeof value === 'object' ? value : null;
  const typed = (source ?? {}) as Partial<SessionCryptoMetadata>;
  const resolvedKid = sanitizeKid(typed.kid) ?? (fallbackKid ?? '');
  const resolvedKdf = typeof typed.kdf === 'string' && typed.kdf.trim().length > 0
    ? typed.kdf.trim()
    : 'hkdf-sha256';
  const resolvedInfo = typeof typed.info === 'string' && typed.info.trim().length > 0
    ? typed.info.trim()
    : 'sid';
  const saltB64 = typeof typed.salt_b64 === 'string' ? typed.salt_b64.trim() : '';
  const resolvedKeyLen = typeof typed.keylen === 'number' && Number.isFinite(typed.keylen)
    ? Math.max(1, Math.trunc(typed.keylen))
    : DEFAULT_DATASET_KEY_LENGTH;
  const resolvedAlgo = typeof typed.algo_ver === 'string' && typed.algo_ver.trim().length > 0
    ? typed.algo_ver.trim()
    : DEFAULT_CRYPTO_ALGO_VERSION;
  return {
    kid: resolvedKid,
    kdf: resolvedKdf,
    info: resolvedInfo,
    salt_b64: saltB64,
    keylen: resolvedKeyLen,
    algo_ver: resolvedAlgo,
  } satisfies SessionCryptoMetadata;
};

const generateRunId = (): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `sim-${timestamp}`;
};

const deriveFeatureCsvFileName = (csvFileName: string | undefined, runId: string): string => {
  const suffix = '-features';
  if (typeof csvFileName === 'string' && csvFileName.trim().length > 0) {
    const trimmed = csvFileName.trim();
    const dotIndex = trimmed.lastIndexOf('.');
    if (dotIndex > 0 && dotIndex < trimmed.length - 1) {
      return `${trimmed.slice(0, dotIndex)}${suffix}${trimmed.slice(dotIndex)}`;
    }
    return `${trimmed}${suffix}.csv`;
  }
  return `simEvents-${runId}${suffix}.csv`;
};

const ensureDirectory = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

const extractDeltaSeconds = (event: SimulationEvent): number | null => {
  const candidates = [
    event.deltaSeconds,
    (event as Record<string, unknown>).delta_seconds,
    (event as Record<string, unknown>).delta_t,
    (event as Record<string, unknown>).deltaT,
    (event as Record<string, unknown>).delta,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
};

export const summarizeDeltas = (events: readonly SimulationEvent[]): Record<string, unknown> => {
  const deltas = events
    .map((event) => extractDeltaSeconds(event))
    .filter((value): value is number => value !== null)
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
  const variance = deltas.reduce((acc, value) => acc + (value - mean) ** 2, 0) / deltas.length;
  const stddev = Math.sqrt(variance);
  const middle = Math.floor(deltas.length / 2);
  const median = deltas.length % 2 === 0
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

export const buildAnomalySummary = (events: readonly SimulationEvent[]): Record<string, number> => {
  const summary: Record<string, number> = {};
  for (const event of events) {
    const label = typeof event.anomaly_type === 'string' ? event.anomaly_type : 'unknown';
    summary[label] = (summary[label] || 0) + 1;
  }
  return summary;
};

const computeSessionStats = (events: readonly SimulationEvent[]): { totalSessions: number; perSession: Record<string, number> } => {
  const sessionCounts = new Map<string, number>();
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

const SENSITIVE_METADATA_KEY_PATTERN = /^(authorization|cookie|cookies|set-cookie|jwt|token|id_token|access_token|refresh_token)$/i;
const SENSITIVE_METADATA_VALUE_PATTERN = /(bearer\s+[a-z0-9._~-]+\.[a-z0-9._~-]+\.[a-z0-9._~-]+|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/i;

const sanitizeMetadataValue = (value: unknown): unknown | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    if (SENSITIVE_METADATA_VALUE_PATTERN.test(value)) {
      return undefined;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const sanitizedArray = value
      .map((entry) => sanitizeMetadataValue(entry))
      .filter((entry) => entry !== undefined);
    if (sanitizedArray.length === 0) {
      return undefined;
    }
    return sanitizedArray;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    Object.entries(record).forEach(([key, entry]) => {
      if (SENSITIVE_METADATA_KEY_PATTERN.test(key)) {
        return;
      }
      const sanitizedEntry = sanitizeMetadataValue(entry);
      if (sanitizedEntry !== undefined) {
        sanitized[key] = sanitizedEntry;
      }
    });
    if (Object.keys(sanitized).length === 0) {
      return undefined;
    }
    return sanitized;
  }
  return undefined;
};

const serializeMetadata = (metadata: unknown): Record<string, unknown> => {
  const sanitized = sanitizeMetadataValue(metadata);
  if (sanitized === undefined || sanitized === null) {
    return {};
  }
  if (Array.isArray(sanitized)) {
    return { value: sanitized };
  }
  if (typeof sanitized === 'object') {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
};

const clampWeight = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (numeric <= 0) {
    return 0;
  }
  if (numeric >= 1) {
    return 1;
  }
  return numeric;
};

const normalizePropagationModeValue = (
  value: unknown,
  fallback: 'propagate' | 'local',
): 'propagate' | 'local' => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'propagate') {
      return 'propagate';
    }
    if (normalized === 'local') {
      return 'local';
    }
  }
  return fallback;
};

const normalizeGapTypeValue = (value: unknown): 'long' | 'short' | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'long' || normalized === 'short') {
    return normalized;
  }
  return null;
};

const toNumberOrNull = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const resolveTimeAnomalyDefaults = (
  parameters: Record<string, unknown> | undefined,
): { mode: string; weights: { propagate: number; local: number } } => {
  const raw = parameters && typeof parameters === 'object' ? (parameters.time_anomaly as unknown) : null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const weightsRaw = record.weights;
    const propagate = weightsRaw && typeof weightsRaw === 'object'
      ? clampWeight((weightsRaw as Record<string, unknown>).propagate, DEFAULT_TIME_ANOMALY_PROPAGATE_WEIGHT)
      : DEFAULT_TIME_ANOMALY_PROPAGATE_WEIGHT;
    return {
      mode: typeof record.mode === 'string' ? record.mode : 'auto',
      weights: {
        propagate,
        local: Math.max(0, 1 - propagate),
      },
    };
  }
  return {
    mode: 'auto',
    weights: {
      propagate: DEFAULT_TIME_ANOMALY_PROPAGATE_WEIGHT,
      local: 1 - DEFAULT_TIME_ANOMALY_PROPAGATE_WEIGHT,
    },
  };
};

const fallbackModeFromConfig = (configMode: string, propagateWeight: number): 'propagate' | 'local' => {
  const normalized = typeof configMode === 'string' ? configMode.trim().toLowerCase() : '';
  if (normalized === 'propagate') {
    return 'propagate';
  }
  if (normalized === 'local') {
    return 'local';
  }
  return propagateWeight >= 0.5 ? 'propagate' : 'local';
};

const buildTimeAnomalyMetaRecords = (
  events: readonly SimulationEvent[],
  runId: string,
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown>[] => {
  const defaults = resolveTimeAnomalyDefaults(parameters);
  const records: Record<string, unknown>[] = [];
  events.forEach((event, index) => {
    if (!event || typeof event !== 'object') {
      return;
    }
    const anomalyTagRaw = (event as Record<string, unknown>)._anomalyType;
    const anomalyTag = typeof anomalyTagRaw === 'string' ? anomalyTagRaw : null;
    const metadata = serializeMetadata((event as Record<string, unknown>).metadata);
    const metadataAnomaly = typeof metadata.anomaly === 'string' ? metadata.anomaly : null;
    const normalizedTag = anomalyTag ? anomalyTag.toLowerCase() : metadataAnomaly ? metadataAnomaly.toLowerCase() : null;
    if (normalizedTag !== 'timedeviation' && normalizedTag !== 'time_deviation') {
      return;
    }
    const detailsRaw = (event as Record<string, unknown>)._anomalyDetails;
    const details = detailsRaw && typeof detailsRaw === 'object' && !Array.isArray(detailsRaw)
      ? (detailsRaw as Record<string, unknown>)
      : {};
    const timeMetaRaw = metadata.time_anomaly;
    const timeMeta = timeMetaRaw && typeof timeMetaRaw === 'object' && !Array.isArray(timeMetaRaw)
      ? (timeMetaRaw as Record<string, unknown>)
      : {};
    const weightsMeta = timeMeta.weights && typeof timeMeta.weights === 'object' && !Array.isArray(timeMeta.weights)
      ? (timeMeta.weights as Record<string, unknown>)
      : {};
    const propagateWeight = clampWeight(details.propagateWeight ?? weightsMeta.propagate, defaults.weights.propagate);
    const propagationMode = normalizePropagationModeValue(
      details.propagationMode ?? timeMeta.propagation_mode,
      fallbackModeFromConfig(defaults.mode, propagateWeight),
    );
    const gapType = normalizeGapTypeValue(details.mode ?? timeMeta.gap_type);
    const desiredDelta = toNumberOrNull(details.desiredDelta ?? timeMeta.desired_delta);
    const sequenceIndex = toNumberOrNull(metadata.sequence_index);
    records.push({
      type: 'time-anomaly',
      run_id: runId,
      idx: index,
      session_id: typeof event.session_id === 'string' ? event.session_id : null,
      uid: typeof event.uid === 'string' ? event.uid : null,
      sequence_index: sequenceIndex,
      propagation_mode: propagationMode,
      mode_setting: defaults.mode,
      gap_type: gapType,
      desired_delta: desiredDelta,
      weights: {
        propagate: propagateWeight,
        local: Math.max(0, 1 - propagateWeight),
      },
    });
  });
  return records;
};

const resolveSidFinal = (event: SimulationEvent): unknown => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  if (hasOwn.call(event, 'sid_final')) {
    const explicit = (event as Record<string, unknown>).sid_final;
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

const normalizeAnomalyTypeValue = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'normal' || lower === 'none') {
    return null;
  }
  return trimmed;
};

const resolveAnomalyType = (event: SimulationEvent): string | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const direct = normalizeAnomalyTypeValue((event as Record<string, unknown>).anomaly_type);
  if (direct) {
    return direct;
  }
  const marked = normalizeAnomalyTypeValue((event as Record<string, unknown>)._anomalyType);
  if (marked) {
    return marked;
  }
  const metadata = serializeMetadata((event as Record<string, unknown>).metadata);
  const metaAnomaly = normalizeAnomalyTypeValue(metadata.anomaly);
  if (metaAnomaly) {
    return metaAnomaly;
  }
  return null;
};

const resolveAnomalyReason = (event: SimulationEvent): string | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const details = (event as Record<string, unknown>)._anomalyDetails;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const reason = (details as Record<string, unknown>).reason;
    if (typeof reason === 'string' && reason.trim().length > 0) {
      return reason.trim();
    }
  }
  const metadata = serializeMetadata((event as Record<string, unknown>).metadata);
  const metadataReason = metadata.anomaly_reason ?? metadata.reason;
  if (typeof metadataReason === 'string' && metadataReason.trim().length > 0) {
    return metadataReason.trim();
  }
  return null;
};

const buildAuditRecords = (events: readonly SimulationEvent[]): AuditRecord[] => {
  return events.map((event, index) => {
    const metadata = serializeMetadata(event?.metadata);
    const opCategory =
      sanitizeStringField((event as Record<string, unknown>).op_category)
        ?? sanitizeStringField(metadata.op_category)
        ?? null;
    const sidFinalRaw = resolveSidFinal(event);
    const sidFinal = sanitizeSessionIdentifier(sidFinalRaw);
    const deltaSeconds = extractDeltaSeconds(event);
    const latency = sanitizeNumberField((event as Record<string, unknown>).latency_ms);
    const statusCode =
      sanitizeNumberField((event as Record<string, unknown>).status_code)
        ?? sanitizeNumberField((event as Record<string, unknown>).status);
    const timeLabel = sanitizeStringField((event as Record<string, unknown>).time_label);
    const paramsEntries: [string, number | string | null][] = [];
    if (deltaSeconds !== null && Number.isFinite(deltaSeconds)) {
      paramsEntries.push(['delta_seconds', Number(deltaSeconds)]);
    }
    if (latency !== null) {
      paramsEntries.push(['latency_ms', latency]);
    }
    if (statusCode !== null) {
      paramsEntries.push(['status_code', statusCode]);
    }
    if (timeLabel) {
      paramsEntries.push(['time_label', timeLabel]);
    }
    const params: Record<string, number | string | null> = {};
    paramsEntries.forEach(([key, value]) => {
      params[key] = value;
    });
    return {
      idx: index,
      sid_final: sidFinal,
      op_category: opCategory,
      anomaly_type: resolveAnomalyType(event),
      reason: resolveAnomalyReason(event),
      params,
    } satisfies AuditRecord;
  });
};

export const appendAudit = async (
  filePath: string,
  records: readonly AuditRecord[],
  options: { truncate?: boolean } = {},
): Promise<number> => {
  if (!Array.isArray(records) || records.length === 0) {
    if (options.truncate) {
      await fs.writeFile(filePath, '', { encoding: 'utf8' });
    }
    return 0;
  }
  const content = records.map((record) => JSON.stringify(record)).join('\n').concat('\n');
  if (options.truncate) {
    await fs.writeFile(filePath, content, { encoding: 'utf8' });
  } else {
    await fs.appendFile(filePath, content, { encoding: 'utf8' });
  }
  return records.length;
};

const buildFeatureSchemaColumns = (columns: readonly string[]): FeatureSchemaColumn[] =>
  columns.map((name) => {
    const definition = FEATURE_COLUMN_DEFINITIONS[name];
    if (definition) {
      return { ...definition };
    }
    if (name.startsWith('m_q')) {
      return {
        name,
        type: 'number',
        unit: 'seconds',
        description: 'Quantile of Δt distribution',
      } satisfies FeatureSchemaColumn;
    }
    return {
      name,
      type: 'number',
      unit: null,
      description: 'Derived feature',
    } satisfies FeatureSchemaColumn;
  });

const buildSchemaDocument = (
  featureColumns: readonly string[],
  featureAugmenter: FeatureAugmenterOptions,
  generatedAtUtc: string,
): Record<string, unknown> => {
  const rawSchemaData = { columns: RAW_SCHEMA_COLUMNS };
  const featureSchemaData = {
    columns: buildFeatureSchemaColumns(featureColumns),
    window_size: featureAugmenter.windowSize,
    quantiles: [...featureAugmenter.quantiles],
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'Session simulation output schema',
    type: 'object',
    version: SCHEMA_VERSION,
    generated_at_utc: generatedAtUtc,
    raw_schema: rawSchemaData,
    features_schema: featureSchemaData,
    properties: {
      version: { const: SCHEMA_VERSION },
      generated_at_utc: { type: 'string', format: 'date-time' },
      raw_schema: {
        type: 'object',
        properties: {
          columns: {
            type: 'array',
            minItems: RAW_SCHEMA_COLUMNS.length,
            const: rawSchemaData.columns,
            items: { $ref: '#/$defs/rawColumn' },
          },
        },
        required: ['columns'],
        additionalProperties: false,
        const: rawSchemaData,
      },
      features_schema: {
        type: 'object',
        properties: {
          columns: {
            type: 'array',
            minItems: featureColumns.length,
            const: featureSchemaData.columns,
            items: { $ref: '#/$defs/featureColumn' },
          },
          window_size: { type: 'integer', const: featureSchemaData.window_size },
          quantiles: {
            type: 'array',
            const: featureSchemaData.quantiles,
            items: { type: 'number' },
          },
        },
        required: ['columns', 'window_size', 'quantiles'],
        additionalProperties: false,
        const: featureSchemaData,
      },
    },
    required: ['version', 'generated_at_utc', 'raw_schema', 'features_schema'],
    additionalProperties: false,
    $defs: {
      rawColumn: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { enum: ['string', 'number', 'integer'] },
          pattern: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['name', 'type', 'description'],
        additionalProperties: false,
      },
      featureColumn: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { enum: ['string', 'number', 'integer'] },
          unit: { type: ['string', 'null'] },
          description: { type: 'string' },
        },
        required: ['name', 'type', 'description', 'unit'],
        additionalProperties: false,
      },
    },
  };
};

interface BuildRunMetaInput {
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
}

export const buildRunMeta = (input: BuildRunMetaInput): RunMeta => {
  const sortedStrategies = Array.from(new Set(input.strategies))
    .map((strategy) => (typeof strategy === 'string' ? strategy : ''))
    .filter((strategy) => strategy.length > 0)
    .sort();
  const clonedAugmenter = cloneFeatureAugmenterOptions(input.featureAugmenter);
  const clipBounds = {
    z: cloneClipBounds(clonedAugmenter.clipBounds.z),
    z_robust: cloneClipBounds(clonedAugmenter.clipBounds.z_robust),
    z_hourly: cloneClipBounds(clonedAugmenter.clipBounds.z_hourly),
    log_burst_z: cloneClipBounds(clonedAugmenter.clipBounds.log_burst_z),
  } as FeatureAugmenterClipBounds;
  return {
    run_id: input.runId,
    created_at_utc: input.createdAtUtc,
    algo_ver: SIMULATOR_ALGO_VERSION,
    simulator_version: SIMULATOR_VERSION,
    seed: input.seed ?? null,
    data_fingerprint: {
      csv_sha256: input.csvHash,
      features_csv_sha256: input.featuresCsvHash ?? null,
      schema_sha256: input.schemaSha256,
      event_count: input.eventCount,
      session_count: input.sessionCount,
    },
    delta_t_generation: {
      method: 'session_diff',
      epsilon_seconds: input.measurementEpsilon,
      epsilon_t_seconds: input.epsilonT,
      feature_window_size: clonedAugmenter.windowSize,
      feature_quantiles: [...clonedAugmenter.quantiles],
      clip_bounds: clipBounds,
    },
    injection_summary: {
      strategies: sortedStrategies,
      anomaly_summary: { ...input.anomalySummary },
      anomaly_rate: input.anomalyRate,
      anomaly_count: input.anomalyCount,
      time_deviation: {
        method: input.timeDeviation.method,
        quantile: input.timeDeviation.quantile,
        threshold_seconds: input.timeDeviation.thresholdSeconds,
        vote_window: input.timeDeviation.voteWindow,
        vote_threshold: input.timeDeviation.voteThreshold,
        hysteresis_hold: input.timeDeviation.hysteresisHold,
      },
    },
    environment: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      env: input.env,
      gpu_mode: typeof input.gpuMode === 'string' && input.gpuMode.trim().length > 0
        ? input.gpuMode.trim()
        : null,
    },
    kid: input.kid ?? null,
    crypto: {
      kid: input.crypto.kid,
      kdf: input.crypto.kdf,
      info: input.crypto.info,
      salt_b64: input.crypto.salt_b64,
      keylen: input.crypto.keylen,
      algo_ver: input.crypto.algo_ver,
    },
  } satisfies RunMeta;
};

const CSV_NULL_LITERAL = 'null';

const sanitizeStringField = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveGitCommit = (): string | null => {
  try {
    const output = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    return null;
  }
};

const writeJsonArtifact = async (targetPath: string, payload: unknown): Promise<string> => {
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(targetPath, content, { encoding: 'utf8' });
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
};

const sanitizeNumberField = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
};

const sanitizeEpochSeconds = (value: unknown): number | null => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    const absolute = Math.abs(value);
    if (absolute >= 1e12) {
      return value / 1000;
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return sanitizeEpochSeconds(numeric);
    }
  }
  const parsed = parseTimestamp(value);
  if (!parsed) {
    return null;
  }
  const seconds = parsed.getTime() / 1000;
  return Number.isFinite(seconds) ? seconds : null;
};

const sanitizeSessionIdentifier = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

interface CsvRowPayload {
  base: unknown[];
  features: unknown[];
  sidFinal: unknown;
}

const resolveCsvRowPayload = (
  event: AugmentedSimulationEvent,
  featureColumns: readonly string[],
): CsvRowPayload => {
  const safeEvent = event && typeof event === 'object' ? event : ({} as AugmentedSimulationEvent);
  const metadata = serializeMetadata(safeEvent.metadata);
  const sidFinal = resolveSidFinal(safeEvent);
  const timestampEpoch =
    sanitizeEpochSeconds(safeEvent.timestamp_utc ?? (safeEvent as Record<string, unknown>).timestamp)
      ?? null;
  const uid = sanitizeStringField(safeEvent.uid) ?? CSV_NULL_LITERAL;
  const sessionId = sanitizeSessionIdentifier(safeEvent.session_id) ?? CSV_NULL_LITERAL;
  const method = sanitizeStringField(safeEvent.method) ?? CSV_NULL_LITERAL;
  const pathValue = sanitizeStringField(safeEvent.path) ?? CSV_NULL_LITERAL;
  const refererValue = sanitizeStringField(safeEvent.referer) ?? CSV_NULL_LITERAL;
  const userAgent = sanitizeStringField((safeEvent as Record<string, unknown>).user_agent) ?? CSV_NULL_LITERAL;
  const ipValue = sanitizeStringField((safeEvent as Record<string, unknown>).ip) ?? CSV_NULL_LITERAL;
  const cookieValue = sanitizeStringField((safeEvent as Record<string, unknown>).cookie) ?? CSV_NULL_LITERAL;
  const opCategoryValue = sanitizeStringField((safeEvent as Record<string, unknown>).op_category) ?? CSV_NULL_LITERAL;
  const userId = sanitizeStringField(safeEvent.user_id) ?? CSV_NULL_LITERAL;
  const eventName = sanitizeStringField(safeEvent.event) ?? CSV_NULL_LITERAL;
  const statusCode =
    sanitizeNumberField((safeEvent as Record<string, unknown>).status_code)
      ?? sanitizeNumberField((safeEvent as Record<string, unknown>).status)
      ?? CSV_NULL_LITERAL;
  const latency = sanitizeNumberField(safeEvent.latency_ms) ?? CSV_NULL_LITERAL;
  const deltaT = extractDeltaSeconds(safeEvent);
  const featureValues = featureColumns.map((column) => (safeEvent as Record<string, unknown>)[column] ?? null);
  const baseValues = [
    timestampEpoch ?? CSV_NULL_LITERAL,
    uid,
    sessionId,
    method,
    pathValue,
    refererValue,
    userAgent,
    ipValue,
    cookieValue,
    opCategoryValue,
  ];
  const featureExtras = [userId, eventName, statusCode, latency, deltaT, metadata];
  return {
    base: baseValues,
    features: [...featureExtras, ...featureValues],
    sidFinal,
  };
};

export const formatCsvAugmented = (
  event: AugmentedSimulationEvent,
  featureColumns: readonly string[],
): string => {
  const payload = resolveCsvRowPayload(event, featureColumns);
  validateContractColumns(payload.base);
  const row = payload.base.map(toCsvField);
  return row.join(',');
};

interface FormatCsvRowsOptions extends AugmentComputationOptions {
  includeFeatures?: boolean;
}

interface FormatCsvRowsResult {
  baseContent: string;
  featureContent?: string;
  featureHeader?: string[];
}

const formatCsvRows = (
  events: readonly SimulationEvent[],
  extras?: FeatureOverrides,
  options?: FormatCsvRowsOptions,
): FormatCsvRowsResult => {
  const { includeFeatures = false, ...augmentOptions } = options ?? {};
  const featureOptions = resolveFeatureAugmenterOptions(augmentOptions as Record<string, unknown>);
  const featureColumns = buildFeatureColumnList(featureOptions);
  const augmented = augmentRows(events, extras ?? {}, {
    ...augmentOptions,
    windowSize: featureOptions.windowSize,
    quantiles: featureOptions.quantiles,
    clipBounds: featureOptions.clipBounds,
  });
  const headerColumns = [...CSV_BASE_COLUMNS];
  validateContractColumns(headerColumns);
  const rows = [headerColumns.join(',')];
  const featureHeader = includeFeatures
    ? [
        ...CSV_BASE_COLUMNS,
        ...FEATURE_ADDITIONAL_COLUMNS,
        ...featureColumns,
        ...CSV_TRAILING_COLUMNS,
      ]
    : null;
  const featureRows = featureHeader ? [featureHeader.join(',')] : null;
  for (const event of augmented) {
    const payload = resolveCsvRowPayload(event, featureColumns);
    validateContractColumns(payload.base);
    rows.push(payload.base.map(toCsvField).join(','));
    if (featureRows && featureHeader) {
      featureRows.push([...payload.base, ...payload.features, payload.sidFinal].map(toCsvField).join(','));
    }
  }
  const baseContent = rows.join('\n').concat('\n');
  const featureContent = featureRows ? featureRows.join('\n').concat('\n') : undefined;
  return {
    baseContent,
    featureContent,
    featureHeader: featureHeader ?? undefined,
  };
};

const defaultManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  scenario_id: overrides.scenario_id ?? null,
  generated_at: overrides.generated_at ?? new Date().toISOString(),
  seed: overrides.seed ?? null,
  transition_table_version: overrides.transition_table_version ?? null,
  run_id: overrides.run_id ?? generateRunId(),
  parameters: overrides.parameters ?? {},
  tags: overrides.tags ?? [],
  notes: overrides.notes ?? null,
});

export const persistSimulationRun = async (
  input: PersistSimulationInput,
): Promise<PersistSimulationResult> => {
  const events = Array.isArray(input?.events) ? (input.events as SimulationEvent[]) : [];
  if (events.length === 0) {
    throw new Error('persistSimulationRun requires a non-empty events array');
  }

  const labeled = labelSequence(events);
  const measurementEpsilon = estimateMeasurementEpsilon(labeled);
  const epsilonT = resolveEpsilonT(input, measurementEpsilon);
  const offsetSeconds = resolveTimezoneOffsetSeconds(labeled);
  const runId = sanitizeRunId(input?.runId) || generateRunId();
  const generatedAt = new Date().toISOString();
  const outputDir = input?.outputDir ? path.resolve(input.outputDir) : config.simLogRoot;
  const featureAugmenter = resolveFeatureAugmenterFromInput(input);
  const featureColumnList = buildFeatureColumnList(featureAugmenter);
  let metaPath: string | null = null;
  const includeFeaturesCsv = Boolean(input?.includeFeaturesCsv);
  const kid = sanitizeKid(input?.kid ?? input?.manifest?.kid ?? null);
  const cryptoMetadata = sanitizeCryptoMetadata(input?.crypto ?? null, kid);
  if (!cryptoMetadata.kid && kid) {
    cryptoMetadata.kid = kid;
  }
  const manifestCrypto = {
    kid: cryptoMetadata.kid,
    kdf: cryptoMetadata.kdf,
    info: cryptoMetadata.info,
    salt_b64: cryptoMetadata.salt_b64,
    keylen: cryptoMetadata.keylen,
    algo_ver: cryptoMetadata.algo_ver,
  } satisfies SessionCryptoMetadata;

  await ensureDirectory(outputDir);

  const csvFileName = input?.csvFileName || `simEvents-${runId}.csv`;
  const manifestFileName = input?.manifestFileName || `scenario-${runId}.json`;
  const runMetaFileName = input?.runMetaFileName || DEFAULT_RUN_META_FILE;
  const auditFileName = input?.auditFileName || DEFAULT_AUDIT_FILE;
  const schemaFileName = input?.schemaFileName || DEFAULT_SCHEMA_FILE;
  const csvPath = path.join(outputDir, csvFileName);
  const manifestPath = path.join(outputDir, manifestFileName);
  const runMetaPath = path.join(outputDir, runMetaFileName);
  const auditPath = path.join(outputDir, auditFileName);
  const schemaPath = path.join(outputDir, schemaFileName);

  const { baseContent: csvContent, featureContent, featureHeader } = formatCsvRows(
    labeled,
    input?.featureOverrides,
    {
      epsilonT,
      measurementEpsilon,
      windowSize: featureAugmenter.windowSize,
      quantiles: featureAugmenter.quantiles,
      clipBounds: featureAugmenter.clipBounds,
      includeFeatures: includeFeaturesCsv,
    },
  );
  await fs.writeFile(csvPath, csvContent, { encoding: 'utf8' });

  const csvHash = crypto.createHash('sha256').update(csvContent, 'utf8').digest('hex');
  let featuresCsvPath: string | null = null;
  let featuresCsvHash: string | null = null;

  if (includeFeaturesCsv && featureContent) {
    const featureFileName = input?.featureCsvFileName || deriveFeatureCsvFileName(input?.csvFileName, runId);
    const resolvedFeaturePath = path.join(outputDir, featureFileName);
    await fs.writeFile(resolvedFeaturePath, featureContent, { encoding: 'utf8' });
    featuresCsvPath = resolvedFeaturePath;
    featuresCsvHash = crypto.createHash('sha256').update(featureContent, 'utf8').digest('hex');
  }

  const sessionStats = computeSessionStats(labeled);
  const deltaStats = summarizeDeltas(labeled);
  const anomalySummary = buildAnomalySummary(labeled);
  const totalAnomalies = Object.entries(anomalySummary)
    .filter(([label]) => label !== 'normal')
    .reduce((acc, [, count]) => acc + count, 0);
  const featuresSchemaColumns = [
    ...CSV_BASE_COLUMNS,
    ...FEATURE_ADDITIONAL_COLUMNS,
    ...featureColumnList,
    ...CSV_TRAILING_COLUMNS,
  ];
  const schemaDocument = buildSchemaDocument(
    featuresSchemaColumns,
    cloneFeatureAugmenterOptions(featureAugmenter),
    generatedAt,
  );
  const schemaContent = `${JSON.stringify(schemaDocument, null, 2)}\n`;
  await fs.writeFile(schemaPath, schemaContent, { encoding: 'utf8' });
  const schemaSha256 = crypto.createHash('sha256').update(schemaContent, 'utf8').digest('hex');

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
      csv_sha256: csvHash,
      features_csv_path: featuresCsvPath,
      features_csv_sha256: featuresCsvHash,
      run_meta_path: runMetaPath,
      audit_path: auditPath,
      schema_path: schemaPath,
    },
    source: {
      sim_log_dir: outputDir,
    },
  } as Record<string, unknown>;

  if (kid) {
    manifest.kid = kid;
  }
  manifest.crypto = manifestCrypto;

  manifest.schema_sha256 = schemaSha256;

  const existingTiming = (manifest.timing ?? {}) as Record<string, unknown>;
  manifest.timing = {
    ...existingTiming,
    epsilon_seconds: measurementEpsilon,
    epsilon_t_seconds: epsilonT,
    timezone_offset_seconds: offsetSeconds,
  };

  const featuresSection = (manifest.features ?? {}) as Record<string, unknown>;
  const augmenterClone = cloneFeatureAugmenterOptions(featureAugmenter);
  featuresSection.augmenter = {
    window_size: augmenterClone.windowSize,
    quantiles: [...augmenterClone.quantiles],
    clip_bounds: {
      z: cloneClipBounds(augmenterClone.clipBounds.z),
      z_robust: cloneClipBounds(augmenterClone.clipBounds.z_robust),
      z_hourly: cloneClipBounds(augmenterClone.clipBounds.z_hourly),
      log_burst_z: cloneClipBounds(augmenterClone.clipBounds.log_burst_z),
    },
  };
  featuresSection.columns = featureHeader ?? null;
  featuresSection.include_features_csv = includeFeaturesCsv;
  manifest.features = featuresSection;

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

  const auditRecords = buildAuditRecords(labeled);
  const auditRecordCount = await appendAudit(auditPath, auditRecords, { truncate: true });

  if (input?.extraMetadata && typeof input.extraMetadata === 'object') {
    manifest.extra = { ...input.extraMetadata };
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
  });

  const anomalyMetaRecords = buildTimeAnomalyMetaRecords(labeled, runId, input?.parameters);
  if (anomalyMetaRecords.length > 0) {
    const metaFileName = input?.metaFileName || 'meta.jsonl';
    const resolvedMetaPath = path.join(outputDir, metaFileName);
    const metaContent = anomalyMetaRecords.map((record) => JSON.stringify(record)).join('\n').concat('\n');
    await fs.writeFile(resolvedMetaPath, metaContent, { encoding: 'utf8' });
    metaPath = resolvedMetaPath;
    const outputSection = (manifest.output ?? {}) as Record<string, unknown>;
    outputSection.meta_path = resolvedMetaPath;
    manifest.output = outputSection;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
    });
  }

  const manifestParameters = (manifest.parameters ?? {}) as Record<string, unknown>;
  const manifestAnomalies = Array.isArray(manifestParameters.anomalies)
    ? ((manifestParameters.anomalies as unknown[]) as string[])
    : [];
  const manifestTimeDeviation = (manifestParameters.time_deviation_detector ?? {}) as Record<string, unknown>;
  const manifestTimeDeviationPost = (manifestTimeDeviation.post_process ?? {}) as Record<string, unknown>;
  const anomalyRateValue = extractNumeric(manifestParameters.anomaly_rate) ?? 0;
  const anomalyCountCandidate = extractNumeric(manifestParameters.anomaly_count);
  const anomalyCountValue = typeof anomalyCountCandidate === 'number' && Number.isFinite(anomalyCountCandidate)
    ? anomalyCountCandidate
    : null;
  const timeDeviationMethod =
    typeof manifestTimeDeviation.method === 'string' && manifestTimeDeviation.method.trim().length > 0
      ? manifestTimeDeviation.method
      : 'quantile';
  const timeDeviationQuantile = extractNumeric(manifestTimeDeviation.quantile);
  const timeDeviationThresholdSeconds = extractNumeric(manifestTimeDeviation.threshold_seconds);
  const voteWindowValue = toFiniteNumber(manifestTimeDeviationPost.vote_window, 0);
  const voteThresholdValue = toFiniteNumber(manifestTimeDeviationPost.vote_threshold, 0);
  const hysteresisHoldValue = toFiniteNumber(manifestTimeDeviationPost.hysteresis_hold, 0);

  const runMeta = buildRunMeta({
    runId,
    createdAtUtc: generatedAt,
    seed: typeof manifest.seed === 'string' ? manifest.seed : null,
    csvHash,
    featuresCsvHash,
    schemaSha256,
    eventCount: labeled.length,
    sessionCount: sessionStats.totalSessions,
    measurementEpsilon,
    epsilonT,
    featureAugmenter: cloneFeatureAugmenterOptions(featureAugmenter),
    anomalySummary,
    strategies: manifestAnomalies,
    anomalyRate: anomalyRateValue,
    anomalyCount: anomalyCountValue,
    timeDeviation: {
      method: timeDeviationMethod,
      quantile: timeDeviationQuantile,
      thresholdSeconds: timeDeviationThresholdSeconds,
      voteWindow: voteWindowValue,
      voteThreshold: voteThresholdValue,
      hysteresisHold: hysteresisHoldValue,
    },
    env: config.env,
    gpuMode: typeof process.env.GPU_MODE === 'string' ? process.env.GPU_MODE : null,
    kid,
    crypto: cryptoMetadata,
  });

  await fs.writeFile(runMetaPath, `${JSON.stringify(runMeta, null, 2)}\n`, { encoding: 'utf8' });

  const fairFileName = input?.fairFileName || DEFAULT_FAIR_FILE;
  const datasheetFileName = input?.datasheetFileName || DEFAULT_DATASHEET_FILE;
  const provenanceFileName = input?.provenanceFileName || DEFAULT_PROVENANCE_FILE;
  const fairPath = path.join(outputDir, fairFileName);
  const datasheetPath = path.join(outputDir, datasheetFileName);
  const provenancePath = path.join(outputDir, provenanceFileName);
  const gitCommit = resolveGitCommit();
  const gpuMode = typeof process.env.GPU_MODE === 'string' ? process.env.GPU_MODE : null;

  const fairPayload = {
    dataset: {
      run_id: runId,
      generated_at_utc: generatedAt,
      rows: labeled.length,
      schema_version: SCHEMA_VERSION,
      csv_sha256: csvHash,
      features_csv_sha256: featuresCsvHash,
      schema_sha256: schemaSha256,
    },
    reproducibility: {
      seed: typeof manifest.seed === 'string' ? manifest.seed : null,
      measurement_epsilon_seconds: measurementEpsilon,
      epsilon_t_seconds: epsilonT,
      gpu_mode: gpuMode,
    },
    provenance: {
      git_commit: gitCommit,
      simulator_version: SIMULATOR_VERSION,
      algo_version: SIMULATOR_ALGO_VERSION,
      node_version: process.version,
      platform: process.platform,
    },
    privacy: {
      uid: 'hex(HMAC-SHA256(session_jwt))',
      cookie: 'Derived from uid; no raw JWT persisted',
      authorization_header_retained: false,
    },
  } as Record<string, unknown>;

  const datasheetPayload = {
    title: 'Synthetic session log dataset',
    description: 'Simulation output for Δt-aware LSTM experiments',
    run_id: runId,
    schema_version: SCHEMA_VERSION,
    scenario_id: input?.scenarioId ?? manifest.scenario_id ?? null,
    required_columns: CSV_BASE_COLUMNS,
    feature_columns: featureHeader ?? [],
    hashing: {
      csv_sha256: csvHash,
      features_csv_sha256: featuresCsvHash,
      schema_sha256: schemaSha256,
    },
    contact: {
      project: packageJson.name ?? 'logserver',
      version: packageJson.version ?? SIMULATOR_VERSION,
    },
    environment: {
      node_version: process.version,
      gpu_mode: gpuMode,
    },
    random_seed: typeof manifest.seed === 'string' ? manifest.seed : null,
    dependencies: {
      simulator: SIMULATOR_VERSION,
      algo_version: SIMULATOR_ALGO_VERSION,
    },
  } as Record<string, unknown>;

  const provenancePayload = {
    run_id: runId,
    generated_at_utc: generatedAt,
    git_commit: gitCommit,
    schema_version: SCHEMA_VERSION,
    csv_sha256: csvHash,
    features_csv_sha256: featuresCsvHash,
    schema_sha256: schemaSha256,
    gpu_mode: gpuMode,
    seed: typeof manifest.seed === 'string' ? manifest.seed : null,
    scenario_id: manifest.scenario_id ?? null,
    environment: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  } as Record<string, unknown>;

  const fairSha256 = await writeJsonArtifact(fairPath, fairPayload);
  const datasheetSha256 = await writeJsonArtifact(datasheetPath, datasheetPayload);
  const provenanceSha256 = await writeJsonArtifact(provenancePath, provenancePayload);

  const manifestOutput = (manifest.output ?? {}) as Record<string, unknown>;
  manifestOutput.fair_path = fairPath;
  manifestOutput.fair_sha256 = fairSha256;
  manifestOutput.datasheet_path = datasheetPath;
  manifestOutput.datasheet_sha256 = datasheetSha256;
  manifestOutput.provenance_path = provenancePath;
  manifestOutput.provenance_sha256 = provenanceSha256;
  manifest.output = manifestOutput;
  manifest.provenance = {
    git_commit: gitCommit,
    gpu_mode: gpuMode,
    schema_version: SCHEMA_VERSION,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' });

  return {
    csvPath,
    featuresCsvPath,
    manifestPath,
    metaPath,
    runMetaPath,
    auditPath,
    schemaPath,
    fairPath,
    datasheetPath,
    provenancePath,
    runId,
    events: labeled,
    manifest,
    csvHash,
    featuresCsvHash,
    schemaSha256,
    fairSha256,
    datasheetSha256,
    provenanceSha256,
    auditRecordCount,
    runMeta,
    featureHeader: featureHeader ?? undefined,
  };
};

const simWriter = {
  persistSimulationRun,
  summarizeDeltas,
  buildAnomalySummary,
  augmentRows,
  formatCsvAugmented,
  validateContractColumns,
  appendAudit,
  buildRunMeta,
};

export default simWriter;
