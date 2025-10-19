import * as crypto from 'node:crypto';
import config from '../config';
import logger from '../utils/logger';
import sim from '../sim';
import {
  assertHealthy,
  coerceNumber as coerceHealthNumber,
  coerceTimestamp as coerceHealthTimestamp,
  HealthError,
  readNtpState,
  type NtpMeasurement,
} from '../healthGate';
import {
  buildAnomalySummary,
  DEFAULT_FEATURE_AUGMENTER,
  resolveFeatureAugmenterOptions,
  cloneFeatureAugmenterOptions,
} from '../sim/persistence/simWriter';
import type { TimeDeviationMode, StrategyConfig } from '../sim/generator/anomalyInjector';
import type { FeatureAugmenterOptions, RunMeta } from '../sim/persistence/simWriter';
import type { ScenarioDefinition } from '../sim/scenario';
import type { NormalEvent } from '../sim/generator/normalGenerator';
import type { PersistSimulationResult } from '../sim/persistence/simWriter';
import type {
  TimeDeviationOptions,
  TimeDeviationDiagnostics,
  TimeDeviationDetectionResult,
} from '../sim/detector/timeDeviationDetector';
import {
  DEFAULT_VOTE_WINDOW,
  DEFAULT_VOTE_THRESHOLD,
  DEFAULT_HYSTERESIS_HOLD,
} from '../sim/detector/timeDeviationDetector';

type StrategyName = 'protocolViolation' | 'timeDeviation' | 'authenticationBypass';

interface TimeDeviationStrategyOverride extends StrategyConfig {
  weight: number;
  mode?: TimeDeviationMode;
  propagateWeight?: number | null;
}

type StrategyOverrides = {
  protocolViolation: StrategyConfig;
  timeDeviation: TimeDeviationStrategyOverride;
  authenticationBypass: StrategyConfig;
};

type NumericBounds = { min: number; max: number };

const {
  scenario,
  normalGenerator,
  anomalyInjector,
  timeDeviationDetector,
  protocolValidator,
  labelSequence,
  persistSimulationRun,
} = sim;

const DEFAULT_EVENT_COUNT = 64;
const DEFAULT_SESSION_SPACING_SECONDS = 180;
const DEFAULT_MAX_STEPS = 64;
const DEFAULT_ANOMALY_RATE = 0.2;
const DEFAULT_TIME_DEVIATION_METHOD = 'quantile';
const DEFAULT_TIME_DEVIATION_QUANTILE = 0.99;
const DEFAULT_TIME_DEVIATION_MIN_SAMPLES = 5;
const DEFAULT_TIME_ANOMALY_MODE: TimeDeviationMode = config.timeAnomalyMode as TimeDeviationMode;
const DEFAULT_TIME_ANOMALY_PROPAGATE_WEIGHT = 0.7;
const MIN_DELTA_EPSILON = 1e-6;
const MAX_DELTA_EPSILON = 1;
const DEFAULT_DELTA_EPSILON = Math.min(Math.max(config.deltaEpsilon, MIN_DELTA_EPSILON), MAX_DELTA_EPSILON);
const SID_INFO = Buffer.from('sid', 'utf8');
const SESSION_DATASET_KEY_LENGTH = 32;
const SESSION_CRYPTO_ALGO_VERSION = 'sid-hkdf-sha256-v1';
const JWT_HEADER_B64URL = Buffer.from('{"alg":"HS256","typ":"JWT"}', 'utf8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/u, '');

interface SessionCryptoMaterial {
  datasetKey: Buffer;
  salt: Buffer;
  saltB64: string;
  kid: string;
  algoVersion: string;
}

const HEX_PATTERN = /^[0-9a-f]+$/iu;

const base64UrlEncode = (data: Buffer): string =>
  data
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');

const decodeBase64Input = (raw: string, label: string): Buffer => {
  const normalized = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  const padded = normalized.concat('='.repeat(padding));
  try {
    const decoded = Buffer.from(padded, 'base64');
    if (decoded.length === 0) {
      throw new Error(`${label} decoded to empty buffer`);
    }
    return decoded;
  } catch (error) {
    throw new Error(`${label} must be base64/base64url encoded`);
  }
};

const parseKeyMaterial = (raw: string, label: string): Buffer => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }
  if (HEX_PATTERN.test(trimmed) && trimmed.length % 2 === 0) {
    const hexBuffer = Buffer.from(trimmed, 'hex');
    if (hexBuffer.length === 0) {
      throw new Error(`${label} decoded to empty buffer`);
    }
    return hexBuffer;
  }
  return decodeBase64Input(trimmed, label);
};

let cachedSessionCryptoMaterial: SessionCryptoMaterial | null = null;

const resolveSessionCryptoMaterial = (): SessionCryptoMaterial => {
  if (cachedSessionCryptoMaterial) {
    return cachedSessionCryptoMaterial;
  }
  const jwtHmacKeyRaw = process.env.JWT_HMAC_KEY;
  if (typeof jwtHmacKeyRaw !== 'string' || jwtHmacKeyRaw.trim().length === 0) {
    throw new Error('JWT_HMAC_KEY environment variable is required to derive session identifiers');
  }
  const ikm = parseKeyMaterial(jwtHmacKeyRaw, 'JWT_HMAC_KEY');
  const saltRaw = normalizeNullableString(process.env.SID_SALT_B64 ?? null);
  const salt = saltRaw ? decodeBase64Input(saltRaw, 'SID_SALT_B64') : Buffer.alloc(0);
  const derivedKey = crypto.hkdfSync('sha256', ikm, salt, SID_INFO, SESSION_DATASET_KEY_LENGTH);
  const datasetKey = Buffer.isBuffer(derivedKey)
    ? Buffer.from(derivedKey)
    : Buffer.from(derivedKey as ArrayBuffer);
  const kid = crypto.createHmac('sha256', datasetKey).update('kid', 'utf8').digest('hex').slice(0, 16);
  const saltB64 = salt.length > 0 ? base64UrlEncode(salt) : '';
  cachedSessionCryptoMaterial = {
    datasetKey,
    salt,
    saltB64,
    kid,
    algoVersion: SESSION_CRYPTO_ALGO_VERSION,
  } as SessionCryptoMaterial;
  return cachedSessionCryptoMaterial;
};

const mintSessionJwt = (seed: string, index: number, datasetKey: Buffer): string => {
  const base = normalizeString(seed) || 'sim';
  const payload = {
    seed: base,
    index,
  } as Record<string, unknown>;
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${JWT_HEADER_B64URL}.${payloadB64}`;
  const signature = crypto.createHmac('sha256', datasetKey).update(signingInput, 'utf8').digest();
  const signatureB64 = base64UrlEncode(signature);
  return `${signingInput}.${signatureB64}`;
};

interface EventBlueprint {
  method: string;
  path: string;
  opCategory: string;
  baseLatency: number;
  successStatus: number;
}

const EVENT_BLUEPRINTS: Record<string, EventBlueprint> & { __default: EventBlueprint } = {
  login: { method: 'POST', path: '/auth/login', opCategory: 'AUTH', baseLatency: 140, successStatus: 200 },
  browse: { method: 'GET', path: '/workspace/feed', opCategory: 'READ', baseLatency: 95, successStatus: 200 },
  view: { method: 'GET', path: '/workspace/feed', opCategory: 'READ', baseLatency: 90, successStatus: 200 },
  edit: { method: 'POST', path: '/workspace/edit', opCategory: 'UPDATE', baseLatency: 130, successStatus: 200 },
  save: { method: 'PUT', path: '/workspace/save', opCategory: 'UPDATE', baseLatency: 150, successStatus: 200 },
  delete: { method: 'DELETE', path: '/workspace/delete', opCategory: 'UPDATE', baseLatency: 170, successStatus: 403 },
  logout: { method: 'POST', path: '/auth/logout', opCategory: 'AUTH', baseLatency: 100, successStatus: 200 },
  __default: { method: 'POST', path: '/workspace/unknown', opCategory: 'READ', baseLatency: 120, successStatus: 200 },
};

const STRATEGY_ALIASES: Record<string, StrategyName> = {
  protocol: 'protocolViolation',
  protocol_violation: 'protocolViolation',
  protocolviolation: 'protocolViolation',
  time: 'timeDeviation',
  time_deviation: 'timeDeviation',
  timedeviation: 'timeDeviation',
  auth: 'authenticationBypass',
  authentication: 'authenticationBypass',
  authentication_bypass: 'authenticationBypass',
};

const REFERER_HOSTS = ['app.simulated.local', 'workspace.simulated.local', 'reports.simulated.local'] as const;
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
] as const;
const REFERER_PROTOCOL = 'https://';

export interface SimulationEventMetadata extends Record<string, unknown> {
  scenario?: {
    id: string;
    from: string | null;
    to: string | null;
    probability: number | null;
  };
  sequence_index?: number;
  op_category?: string;
  auth?: Record<string, unknown>;
  anomaly?: string;
}

export interface SimulationEvent extends Record<string, unknown> {
  session_id?: string;
  user_id?: string;
  uid?: string;
  event?: string;
  method?: string;
  path?: string;
  status?: number | null;
  status_code?: number | null;
  latency_ms?: number;
  delta_t?: number;
  timestamp?: string;
  timestamp_utc?: string;
  deltaSeconds?: number | null;
  referer?: string | null;
  user_agent?: string | null;
  ip?: string | null;
  op_category?: string | null;
  anomaly?: boolean;
  anomaly_type?: string;
  anomalyLabel?: number;
  metadata?: SimulationEventMetadata;
  _anomalyType?: string;
  _anomalyDetails?: Record<string, unknown>;
  protocolViolationFlag?: boolean;
  protocolViolationReasons?: unknown[];
  timeDeviationFlag?: boolean;
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationScore?: number;
  [key: string]: unknown;
}

export interface SimulationSummary {
  events: number;
  sessions: number;
  anomalies: Record<string, number>;
}

export interface SimulationFiles {
  csvPath: string;
  featuresCsvPath?: string | null;
  manifestPath: string;
  csvHash: string;
  featuresCsvHash?: string | null;
  metaPath?: string | null;
  runMetaPath?: string;
  auditPath?: string;
  schemaPath?: string;
  schemaSha256?: string;
}

export interface GenerateScenarioOptions extends Record<string, unknown> {
  seed?: string | number | null;
  count?: number;
  maxSteps?: number;
  anomalyRate?: number;
  anomalyCount?: number | null;
  anomalies?: Iterable<string> | string | null;
  persist?: boolean;
  runId?: string | null;
  outputDir?: string;
  csvFileName?: string;
  featureCsvFileName?: string | null;
  manifestFileName?: string;
  sessionSpacingSeconds?: number;
  scenarioPath?: string | null;
  scenarioFile?: string | null;
  startTime?: Date | string | null;
  timeDeviation?: Partial<TimeDeviationOptions> | null;
  featureAugmenter?: Partial<FeatureAugmenterOptions> | Record<string, unknown> | null;
  feature_augmenter?: Partial<FeatureAugmenterOptions> | Record<string, unknown> | null;
  timeAnomalyMode?: TimeDeviationMode | string | null;
  timeAnomalyPropWeight?: number | string | null;
  deltaEpsilon?: number | string | null;
  includeFeaturesCsv?: boolean | string | null;
  kid?: string | null;
  runMetaFileName?: string | null;
  auditFileName?: string | null;
  schemaFileName?: string | null;
  ntpP95Ms?: number | string | null;
  ntpLastMeasuredAt?: number | string | Date | null;
  ntpFreshnessMs?: number | string | null;
  ntpStatePath?: string | null;
  healthNow?: number | string | Date | null;
  healthValidated?: boolean;
}

export interface SimulationParameters extends Record<string, unknown> {
  count: number;
  anomalies: string[];
  seed: string;
  seed_source: string | null;
  scenario_path: string | null;
  anomaly_rate: number;
  anomaly_count: number | null;
  session_spacing_seconds: number;
  persist: boolean;
  max_steps: number;
  delta_epsilon: number;
  include_features_csv: boolean;
  feature_csv_file_name: string | null;
  feature_augmenter: {
    window_size: number;
    quantiles: number[];
    clip_bounds: {
      z: NumericBounds;
      z_robust: NumericBounds;
      z_hourly: NumericBounds;
      log_burst_z: NumericBounds;
    };
  };
  time_deviation_detector: {
    method: string;
    quantile: number | null;
    min_samples: number;
    fallback_threshold_seconds: number | null;
    threshold_seconds: number | null;
    diagnostics?: TimeDeviationDiagnostics | null;
    calibration?: TimeDeviationDiagnostics['spot'] | null;
    post_process: {
      vote_window: number;
      vote_threshold: number;
      hysteresis_hold: number;
    };
  };
  protocol_validator: {
    enabled: boolean;
  };
  time_anomaly: {
    mode: TimeDeviationMode;
    weights: { propagate: number; local: number };
  };
  ntp_health?: {
    p95_ms: number;
    last_measured_at: string;
  } | null;
  kid?: string | null;
}

export interface SimulationResult {
  scenarioId: string;
  generated_at: string;
  params: SimulationParameters;
  events: SimulationEvent[];
  summary: SimulationSummary;
  files?: SimulationFiles;
  manifest?: Record<string, unknown>;
  run_meta?: RunMeta;
}

export type NormalizedAnomalyList = Set<StrategyName>;

type SeedResolution = {
  value: string;
  source: 'provided' | 'generated';
};

interface SessionIdentifiers {
  sessionId: string;
  userId: string;
  uid: string;
  userAgent: string;
  ip: string;
  refererHost: string;
}

interface DefaultParameterInput {
  count: number;
  anomalies: NormalizedAnomalyList;
  seed: string;
  seedSource: string | null;
  scenarioPath: string | null;
  anomalyRate: number;
  anomalyCount: number | null;
  sessionSpacingSeconds: number;
  persist: boolean;
  maxSteps: number;
  deltaEpsilon: number;
  includeFeaturesCsv: boolean;
  featureCsvFileName: string | null;
  featureAugmenter: FeatureAugmenterOptions;
  timeDeviationMethod: string;
  timeDeviationQuantile: number | null;
  timeDeviationMinSamples: number;
  timeDeviationFallback: number | null;
  timeDeviationVoteWindow: number;
  timeDeviationVoteThreshold: number;
  timeDeviationHysteresisHold: number;
  timeAnomalyMode: TimeDeviationMode;
  timeAnomalyPropWeight: number;
  kid: string | null;
}

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const normalizeNullableString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const ensureLeadingSlash = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  if (value.startsWith('/')) {
    return value;
  }
  return `/${value}`;
};

const computeSessionIp = (index: number): string => {
  const octet1 = 10;
  const octet2 = 16 + (index % 64);
  const octet3 = (index * 29) % 256;
  const octet4 = ((index * 53) % 253) + 2;
  return `${octet1}.${octet2}.${octet3}.${octet4}`;
};

const computeSessionUserAgent = (index: number): string => {
  return USER_AGENTS[index % USER_AGENTS.length];
};

const computeRefererHost = (index: number): string => {
  return REFERER_HOSTS[index % REFERER_HOSTS.length];
};

const formatRefererUrl = (host: string, pathValue: string | null): string | null => {
  if (!pathValue) {
    return null;
  }
  const normalizedPath = ensureLeadingSlash(pathValue);
  if (!normalizedPath) {
    return null;
  }
  return `${REFERER_PROTOCOL}${host}${normalizedPath}`;
};

const normalizeSeedInput = (seed: unknown): string | null => {
  if (seed === undefined || seed === null) {
    return null;
  }
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return seed.toString(10);
  }
  if (typeof seed === 'string') {
    const trimmed = seed.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const generateSeed = (): string => crypto.randomBytes(12).toString('hex');

const normalizeTimeAnomalyMode = (value: unknown): TimeDeviationMode | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'propagate' || normalized === 'local') {
    return normalized;
  }
  return null;
};

const resolveTimeAnomalyMode = (value: unknown, fallback: TimeDeviationMode): TimeDeviationMode => {
  const normalized = normalizeTimeAnomalyMode(value);
  return normalized ?? fallback;
};

const resolvePropagateWeight = (value: unknown, fallback: number): number => {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
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

const resolveSeed = (seed: unknown): SeedResolution => {
  const normalized = normalizeSeedInput(seed);
  if (normalized !== null) {
    return {
      value: normalized,
      source: 'provided',
    };
  }
  return {
    value: generateSeed(),
    source: 'generated',
  };
};

const parsePositiveNumber = (candidate: unknown, fallback: number): number => {
  const value = Number(candidate);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
};

const parseNonNegativeNumber = (candidate: unknown, fallback: number | null): number | null => {
  const value = Number(candidate);
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
};

const clampDeltaEpsilon = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  if (value < MIN_DELTA_EPSILON) {
    return MIN_DELTA_EPSILON;
  }
  if (value > MAX_DELTA_EPSILON) {
    return MAX_DELTA_EPSILON;
  }
  return value;
};

const resolveDeltaEpsilonOption = (candidate: unknown, fallback: number): number => {
  if (candidate === undefined || candidate === null || candidate === '') {
    return fallback;
  }
  if (typeof candidate === 'number') {
    return clampDeltaEpsilon(candidate, fallback);
  }
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      return fallback;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return clampDeltaEpsilon(numeric, fallback);
    }
  }
  return fallback;
};

const parseIntegerWithMin = (candidate: unknown, fallback: number, minimum: number): number => {
  if (candidate === null || candidate === undefined || candidate === '') {
    return fallback;
  }
  const value = Number(candidate);
  if (Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    if (truncated >= minimum) {
      return truncated;
    }
  }
  return fallback;
};

const parseBoolean = (candidate: unknown, fallback: boolean): boolean => {
  if (typeof candidate === 'boolean') {
    return candidate;
  }
  if (typeof candidate === 'string') {
    const normalized = candidate.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

export const normalizeAnomalyList = (input: unknown): NormalizedAnomalyList => {
  if (!input) {
    return new Set<StrategyName>();
  }
  const list = Array.isArray(input) ? input : String(input).split(',');
  const normalized = list
    .map((item) => normalizeString(item).toLowerCase())
    .filter((item) => item.length > 0)
    .map((item) => STRATEGY_ALIASES[item] || (item as StrategyName));
  const filtered = normalized.filter((item): item is StrategyName =>
    item === 'protocolViolation' || item === 'timeDeviation' || item === 'authenticationBypass'
  );
  return new Set(filtered);
};

const buildStrategyOverrides = (
  selectedStrategies: NormalizedAnomalyList,
  timeAnomalyMode: TimeDeviationMode,
  timeAnomalyPropWeight: number,
): StrategyOverrides => ({
  protocolViolation: { weight: selectedStrategies.has('protocolViolation') ? 1 : 0 },
  timeDeviation: {
    weight: selectedStrategies.has('timeDeviation') ? 1 : 0,
    mode: timeAnomalyMode,
    propagateWeight: timeAnomalyPropWeight,
  },
  authenticationBypass: { weight: selectedStrategies.has('authenticationBypass') ? 1 : 0 },
});

const parseStartTime = (candidate: unknown): Date => {
  if (!candidate) {
    return new Date();
  }
  if (candidate instanceof Date) {
    return new Date(candidate.getTime());
  }
  const parsed = new Date(candidate as string);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid startTime provided: ${candidate}`);
  }
  return parsed;
};

const createSessionIdentifiers = (seed: string, index: number): SessionIdentifiers => {
  const base = normalizeString(seed) || 'sim';
  const suffix = (index + 1).toString().padStart(3, '0');
  const sanitizedBase = base.replace(/[^a-zA-Z0-9]+/g, '-');
  const cryptoMaterial = resolveSessionCryptoMaterial();
  const rawToken = mintSessionJwt(seed, index, cryptoMaterial.datasetKey);
  const uid = crypto.createHmac('sha256', cryptoMaterial.datasetKey).update(rawToken, 'utf8').digest('hex');
  return {
    sessionId: `sess-${sanitizedBase}-${suffix}`,
    userId: `user-${sanitizedBase}-${suffix}`,
    uid,
    userAgent: computeSessionUserAgent(index),
    ip: computeSessionIp(index),
    refererHost: computeRefererHost(index),
  };
};

const resolveBlueprint = (eventName: unknown): EventBlueprint => {
  const key = normalizeString(eventName).toLowerCase();
  if (key && EVENT_BLUEPRINTS[key]) {
    return EVENT_BLUEPRINTS[key];
  }
  return EVENT_BLUEPRINTS.__default;
};

const deriveStatus = (blueprint: EventBlueprint, anomalyTag: string | null): number => {
  if (!anomalyTag) {
    return blueprint.successStatus || 200;
  }
  const normalized = anomalyTag.toLowerCase();
  if (normalized.includes('auth')) {
    return 401;
  }
  if (normalized.includes('protocol')) {
    return 409;
  }
  if (normalized.includes('time')) {
    return 504;
  }
  return blueprint.successStatus || 200;
};

const deriveLatency = (blueprint: EventBlueprint, deltaSeconds: number | undefined, index: number): number => {
  const base = Number.isFinite(blueprint.baseLatency) ? blueprint.baseLatency : 120;
  const deltaComponent = Number.isFinite(deltaSeconds) ? (deltaSeconds as number) * 40 : 0;
  return Math.max(20, Math.round(base + deltaComponent + (index % 17)));
};

const cloneMetadata = (value: unknown): SimulationEventMetadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as SimulationEventMetadata) };
};

const decorateEvent = ({
  event,
  scenarioId,
  session,
  index,
}: {
  event: SimulationEvent;
  scenarioId: string;
  session: SessionIdentifiers;
  index: number;
}): SimulationEvent => {
  const blueprint = resolveBlueprint(event.event);
  const metadata = cloneMetadata(event.metadata);
  metadata.scenario = {
    id: scenarioId,
    from: (event as Record<string, unknown>).from ? String((event as Record<string, unknown>).from) : null,
    to: (event as Record<string, unknown>).to ? String((event as Record<string, unknown>).to) : null,
    probability: Number.isFinite((event as Record<string, unknown>).probability)
      ? Number((event as Record<string, unknown>).probability)
      : null,
  };
  metadata.sequence_index = index;
  const explicitCategory = normalizeNullableString(event.op_category);
  const metadataCategory = normalizeNullableString(metadata.op_category);
  const resolvedCategoryRaw = explicitCategory || metadataCategory || blueprint.opCategory || null;
  const resolvedCategory = resolvedCategoryRaw ? resolvedCategoryRaw.toUpperCase() : null;
  if (resolvedCategory) {
    metadata.op_category = resolvedCategory;
  }

  const anomalyTag = normalizeString((event as SimulationEvent)._anomalyType || event.anomaly_type || event.anomalyType);
  const deltaSeconds = Number(event.deltaSeconds);

  const record: SimulationEvent = {
    timestamp: typeof event.timestamp === 'string' ? event.timestamp : (event.timestamp_utc as string | undefined),
    session_id: normalizeString(event.session_id) || session.sessionId,
    user_id: normalizeString(event.user_id) || session.userId,
    uid: normalizeString(event.uid) || session.uid,
    event: event.event,
    method: event.method || blueprint.method,
    path: event.path || blueprint.path,
    status: Number.isFinite(event.status) ? Number(event.status) : deriveStatus(blueprint, anomalyTag || null),
    status_code: Number.isFinite(event.status_code)
      ? Number(event.status_code)
      : Number.isFinite(event.status)
        ? Number(event.status)
        : undefined,
    latency_ms: Number.isFinite(event.latency_ms)
      ? Math.round(Number(event.latency_ms))
      : deriveLatency(blueprint, Number.isFinite(deltaSeconds) ? deltaSeconds : undefined, index),
    deltaSeconds: Number.isFinite(deltaSeconds) ? deltaSeconds : undefined,
    metadata,
    op_category: resolvedCategory ?? null,
    user_agent: normalizeNullableString(event.user_agent) ?? session.userAgent,
    ip: normalizeNullableString(event.ip) ?? session.ip,
  };

  if (event.protocolViolationFlag === true) {
    record.protocolViolationFlag = true;
    record.protocolViolationReasons = Array.isArray(event.protocolViolationReasons)
      ? [...event.protocolViolationReasons]
      : [];
  }
  if (event.timeDeviationFlag === true) {
    record.timeDeviationFlag = true;
    record.timeDeviationObservedDeltaSeconds = Number.isFinite(event.timeDeviationObservedDeltaSeconds)
      ? Number(event.timeDeviationObservedDeltaSeconds)
      : undefined;
    record.timeDeviationThresholdSeconds = Number.isFinite(event.timeDeviationThresholdSeconds)
      ? Number(event.timeDeviationThresholdSeconds)
      : undefined;
    record.timeDeviationScore = Number.isFinite(event.timeDeviationScore)
      ? Number(event.timeDeviationScore)
      : undefined;
  }

  if (anomalyTag) {
    record._anomalyType = anomalyTag;
    record.anomaly = true;
  } else if (event.anomaly === true) {
    record.anomaly = true;
  }

  return record;
};

const decorateSequence = (
  events: SimulationEvent[],
  context: { scenarioId: string; session: SessionIdentifiers },
): SimulationEvent[] => {
  const decorated: SimulationEvent[] = [];
  let previousPath: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const decoratedEvent = decorateEvent({
      event: events[index],
      scenarioId: context.scenarioId,
      session: context.session,
      index,
    });

    const normalizedUid = normalizeNullableString(decoratedEvent.uid) ?? context.session.uid;
    decoratedEvent.uid = normalizedUid;

    const sanitizedCurrentPath = ensureLeadingSlash(normalizeNullableString(decoratedEvent.path));
    if (sanitizedCurrentPath) {
      decoratedEvent.path = sanitizedCurrentPath;
    }

    const existingReferer = normalizeNullableString(decoratedEvent.referer);
    const derivedReferer = existingReferer ?? formatRefererUrl(context.session.refererHost, previousPath);
    decoratedEvent.referer = derivedReferer ?? null;

    const resolvedUserAgent = normalizeNullableString(decoratedEvent.user_agent) ?? context.session.userAgent;
    decoratedEvent.user_agent = resolvedUserAgent;

    const resolvedIp = normalizeNullableString(decoratedEvent.ip) ?? context.session.ip;
    decoratedEvent.ip = resolvedIp;

    const statusCandidate = Number.isFinite(decoratedEvent.status_code)
      ? Number(decoratedEvent.status_code)
      : Number.isFinite(decoratedEvent.status)
        ? Number(decoratedEvent.status)
        : null;
    decoratedEvent.status_code = statusCandidate;

    const opCategoryRaw =
      normalizeNullableString(decoratedEvent.op_category)
        ?? normalizeNullableString(decoratedEvent.metadata?.op_category)
        ?? null;
    const opCategory = opCategoryRaw ? opCategoryRaw.toUpperCase() : null;
    if (opCategory) {
      decoratedEvent.op_category = opCategory;
      if (!decoratedEvent.metadata) {
        decoratedEvent.metadata = {} as SimulationEventMetadata;
      }
      decoratedEvent.metadata.op_category = opCategory;
    }

    decorated.push(decoratedEvent);
    previousPath = sanitizedCurrentPath ?? previousPath;
  }
  return decorated;
};

const defaultParameters = (input: DefaultParameterInput): SimulationParameters => ({
  count: input.count,
  anomalies: Array.from(input.anomalies || []),
  seed: input.seed,
  seed_source: input.seedSource,
  scenario_path: input.scenarioPath,
  anomaly_rate: input.anomalyRate,
  anomaly_count: input.anomalyCount,
  session_spacing_seconds: input.sessionSpacingSeconds,
  persist: input.persist,
  max_steps: input.maxSteps,
  delta_epsilon: input.deltaEpsilon,
  include_features_csv: input.includeFeaturesCsv,
  feature_csv_file_name: input.featureCsvFileName,
  feature_augmenter: {
    window_size: input.featureAugmenter.windowSize,
    quantiles: [...input.featureAugmenter.quantiles],
    clip_bounds: {
      z: { ...input.featureAugmenter.clipBounds.z },
      z_robust: { ...input.featureAugmenter.clipBounds.z_robust },
      z_hourly: { ...input.featureAugmenter.clipBounds.z_hourly },
      log_burst_z: { ...input.featureAugmenter.clipBounds.log_burst_z },
    },
  },
  time_deviation_detector: {
    method: input.timeDeviationMethod,
    quantile: Number.isFinite(input.timeDeviationQuantile) ? input.timeDeviationQuantile : null,
    min_samples: input.timeDeviationMinSamples,
    fallback_threshold_seconds: input.timeDeviationFallback,
    threshold_seconds: null,
    calibration: null,
    post_process: {
      vote_window: input.timeDeviationVoteWindow,
      vote_threshold: input.timeDeviationVoteThreshold,
      hysteresis_hold: input.timeDeviationHysteresisHold,
    },
  },
  protocol_validator: {
    enabled: true,
  },
  time_anomaly: {
    mode: input.timeAnomalyMode,
    weights: {
      propagate: input.timeAnomalyPropWeight,
      local: Math.max(0, 1 - input.timeAnomalyPropWeight),
    },
  },
  ntp_health: null,
  kid: input.kid,
});

export const generateScenario = async (options: GenerateScenarioOptions = {}): Promise<SimulationResult> => {
  const resolveFreshness = (value: unknown): number => {
    if (value === null || value === undefined) {
      return 120_000;
    }
    const numeric = coerceHealthNumber(value, 'ntpFreshnessMs');
    if (numeric < 0) {
      throw new HealthError('METRICS_INCONSISTENT', 'ntpFreshnessMs must be non-negative');
    }
    return numeric;
  };

  const resolveNow = (value: unknown): number => {
    if (value === null || value === undefined) {
      return Date.now();
    }
    return coerceHealthTimestamp(value, 'healthNow');
  };

  const healthFreshnessMs = resolveFreshness(options.ntpFreshnessMs ?? null);
  const healthNow = resolveNow(options.healthNow ?? null);
  const healthValidated = options.healthValidated === true;

  const resolveMeasurement = async (): Promise<NtpMeasurement> => {
    if (options.ntpP95Ms !== undefined || options.ntpLastMeasuredAt !== undefined) {
      if (options.ntpP95Ms === undefined || options.ntpLastMeasuredAt === undefined) {
        throw new HealthError('METRICS_INCONSISTENT', 'ntpP95Ms and ntpLastMeasuredAt must both be provided');
      }
      const ntpP95 = coerceHealthNumber(options.ntpP95Ms, 'ntpP95Ms');
      const lastMeasuredAt = coerceHealthTimestamp(options.ntpLastMeasuredAt, 'ntpLastMeasuredAt');
      if (!healthValidated) {
        assertHealthy(ntpP95, lastMeasuredAt, healthNow, healthFreshnessMs);
      }
      return { ntpP95Ms: ntpP95, lastMeasuredAt };
    }
    const statePath = (options.ntpStatePath as string | null | undefined) ?? process.env.NTP_STATE_PATH ?? null;
    const measurement = await readNtpState(statePath);
    assertHealthy(measurement.ntpP95Ms, measurement.lastMeasuredAt, healthNow, healthFreshnessMs);
    return measurement;
  };

  const ntpMeasurement = await resolveMeasurement();

  const count = Number.isInteger(options.count) && (options.count as number) > 0 ? (options.count as number) : DEFAULT_EVENT_COUNT;
  const maxSteps = Number.isInteger(options.maxSteps) && (options.maxSteps as number) > 0 ? (options.maxSteps as number) : DEFAULT_MAX_STEPS;
  const sessionSpacingSeconds = parsePositiveNumber(options.sessionSpacingSeconds, DEFAULT_SESSION_SPACING_SECONDS);
  const persist = parseBoolean(options.persist, true);
  const scenarioPath = (options.scenarioPath ?? options.scenarioFile ?? null) as string | null;
  const anomalyRate = options.anomalyRate !== undefined
    ? parseNonNegativeNumber(options.anomalyRate, DEFAULT_ANOMALY_RATE) ?? DEFAULT_ANOMALY_RATE
    : DEFAULT_ANOMALY_RATE;
  const anomalyCount = options.anomalyCount !== undefined ? parseNonNegativeNumber(options.anomalyCount, null) : null;
  const anomalies = normalizeAnomalyList(options.anomalies);
  const resolvedTimeAnomalyMode = resolveTimeAnomalyMode(options.timeAnomalyMode, DEFAULT_TIME_ANOMALY_MODE);
  const resolvedTimeAnomalyPropWeight = resolvePropagateWeight(
    options.timeAnomalyPropWeight,
    DEFAULT_TIME_ANOMALY_PROPAGATE_WEIGHT,
  );
  const resolvedDeltaEpsilon = resolveDeltaEpsilonOption(options.deltaEpsilon, DEFAULT_DELTA_EPSILON);
  const includeFeaturesCsv = parseBoolean(options.includeFeaturesCsv, false);
  const featureCsvFileName = normalizeNullableString(options.featureCsvFileName ?? null);

  const sessionCryptoMaterial = resolveSessionCryptoMaterial();
  const derivedKid = sessionCryptoMaterial.kid;
  const resolvedKid = normalizeNullableString(options.kid ?? null) ?? derivedKid;
  const cryptoMetadata = {
    kid: sessionCryptoMaterial.kid,
    kdf: 'hkdf-sha256',
    info: 'sid',
    salt_b64: sessionCryptoMaterial.saltB64,
    keylen: SESSION_DATASET_KEY_LENGTH,
    algo_ver: sessionCryptoMaterial.algoVersion,
  } as const;

  const scenarioDefinition = scenario.loadScenario(scenarioPath) as ScenarioDefinition;
  const scenarioId = normalizeString((scenarioDefinition as Record<string, unknown>).id) || 'default-flow';
  const scenarioVersionRaw = (scenarioDefinition as Record<string, unknown>).version;
  const scenarioVersion = typeof scenarioVersionRaw === 'string' ? scenarioVersionRaw : null;

  const baseStartTime = parseStartTime(options.startTime ?? null);
  const seedResolution = resolveSeed(options.seed);
  const resolvedSeed = seedResolution.value;
  const timeDeviationInput = (options.timeDeviation ?? null) as Partial<TimeDeviationOptions> | null;
  const resolvedTimeDeviationMethod =
    typeof timeDeviationInput?.method === 'string' && timeDeviationInput.method
      ? timeDeviationInput.method
      : DEFAULT_TIME_DEVIATION_METHOD;
  const rawQuantile = Number((timeDeviationInput?.quantile ?? null) as number | string | null);
  const resolvedTimeDeviationQuantile = Number.isFinite(rawQuantile)
    ? rawQuantile
    : DEFAULT_TIME_DEVIATION_QUANTILE;
  const resolvedTimeDeviationMinSamples =
    Number.isInteger(timeDeviationInput?.minSamples) && (timeDeviationInput?.minSamples as number) > 0
      ? (timeDeviationInput?.minSamples as number)
      : DEFAULT_TIME_DEVIATION_MIN_SAMPLES;
  const resolvedTimeDeviationFallback =
    timeDeviationInput?.fallbackThresholdSeconds !== undefined
      ? parseNonNegativeNumber(timeDeviationInput?.fallbackThresholdSeconds, null)
      : null;
  const resolvedTimeDeviationThreshold =
    timeDeviationInput?.thresholdSeconds !== undefined
      ? parseNonNegativeNumber(timeDeviationInput?.thresholdSeconds, null)
      : null;
  const resolvedTimeDeviationVoteWindow = parseIntegerWithMin(
    (timeDeviationInput?.voteWindow as number | string | null | undefined) ?? undefined,
    DEFAULT_VOTE_WINDOW,
    1,
  );
  const resolvedTimeDeviationVoteThresholdRaw = parseIntegerWithMin(
    (timeDeviationInput?.voteThreshold as number | string | null | undefined) ?? undefined,
    DEFAULT_VOTE_THRESHOLD,
    1,
  );
  const resolvedTimeDeviationVoteThreshold = Math.min(
    Math.max(resolvedTimeDeviationVoteThresholdRaw, 1),
    resolvedTimeDeviationVoteWindow,
  );
  const resolvedTimeDeviationHysteresisHold = parseIntegerWithMin(
    (timeDeviationInput?.hysteresisHold as number | string | null | undefined) ?? undefined,
    DEFAULT_HYSTERESIS_HOLD,
    0,
  );
  const resolvedTimeDeviationOptions: TimeDeviationOptions = {
    ...(timeDeviationInput ?? {}),
    method: resolvedTimeDeviationMethod,
    quantile: resolvedTimeDeviationQuantile,
    minSamples: resolvedTimeDeviationMinSamples,
    fallbackThresholdSeconds: resolvedTimeDeviationFallback,
    thresholdSeconds: resolvedTimeDeviationThreshold,
    voteWindow: resolvedTimeDeviationVoteWindow,
    voteThreshold: resolvedTimeDeviationVoteThreshold,
    hysteresisHold: resolvedTimeDeviationHysteresisHold,
  };
  const parameterQuantile =
    resolvedTimeDeviationMethod === 'quantile' && Number.isFinite(resolvedTimeDeviationQuantile)
      ? resolvedTimeDeviationQuantile
      : null;
  const featureAugmenterInput = (options.featureAugmenter ?? options.feature_augmenter ?? null) as
    | Partial<FeatureAugmenterOptions>
    | Record<string, unknown>
    | null;
  const resolvedFeatureAugmenter = featureAugmenterInput && typeof featureAugmenterInput === 'object'
    ? resolveFeatureAugmenterOptions(featureAugmenterInput as Record<string, unknown>)
    : cloneFeatureAugmenterOptions(DEFAULT_FEATURE_AUGMENTER);
  const parameters = defaultParameters({
    count,
    anomalies,
    seed: resolvedSeed,
    seedSource: seedResolution.source,
    scenarioPath,
    anomalyRate,
    anomalyCount,
    sessionSpacingSeconds,
    persist,
    maxSteps,
    deltaEpsilon: resolvedDeltaEpsilon,
    includeFeaturesCsv,
    featureCsvFileName,
    featureAugmenter: resolvedFeatureAugmenter,
    timeDeviationMethod: resolvedTimeDeviationMethod,
    timeDeviationQuantile: parameterQuantile,
    timeDeviationMinSamples: resolvedTimeDeviationMinSamples,
    timeDeviationFallback: resolvedTimeDeviationFallback,
    timeDeviationVoteWindow: resolvedTimeDeviationVoteWindow,
    timeDeviationVoteThreshold: resolvedTimeDeviationVoteThreshold,
    timeDeviationHysteresisHold: resolvedTimeDeviationHysteresisHold,
    timeAnomalyMode: resolvedTimeAnomalyMode,
    timeAnomalyPropWeight: resolvedTimeAnomalyPropWeight,
    kid: resolvedKid,
  });
  parameters.ntp_health = {
    p95_ms: ntpMeasurement.ntpP95Ms,
    last_measured_at: new Date(ntpMeasurement.lastMeasuredAt).toISOString(),
  };

  const selectedStrategies = buildStrategyOverrides(
    anomalies,
    resolvedTimeAnomalyMode,
    resolvedTimeAnomalyPropWeight,
  );
  const anomalyStrategies = Array.from(anomalies);
  const startTimeHr = process.hrtime.bigint();

  logger.info('Simulate start', {
    seed: resolvedSeed,
    seed_source: seedResolution.source,
    count,
    max_steps: maxSteps,
    anomaly_rate: anomalyRate,
    anomaly_count: anomalyCount,
    anomalies: anomalyStrategies,
    persist,
    session_spacing_seconds: sessionSpacingSeconds,
    scenario_id: scenarioId,
    scenario_version: scenarioVersion,
    scenario_path: scenarioPath,
    run_id: options.runId || null,
    delta_epsilon: resolvedDeltaEpsilon,
    time_deviation_detector: parameters.time_deviation_detector,
    feature_augmenter: parameters.feature_augmenter,
    time_anomaly: parameters.time_anomaly,
  });

  const events: SimulationEvent[] = [];
  const sessionIds = new Set<string>();
  let sessionIndex = 0;
  let sessionStartTime = new Date(baseStartTime.getTime());
  let lastTimeDeviationResult: TimeDeviationDetectionResult | null = null;

  while (events.length < count) {
    const sessionSeed = `${resolvedSeed}:${sessionIndex}`;
    const sessionIdentifiers = createSessionIdentifiers(resolvedSeed || scenarioId, sessionIndex);

    const baseSequence = normalGenerator.generateNormalSequence({
      scenario: scenarioDefinition,
      seed: sessionSeed,
      startTime: sessionStartTime,
      maxSteps,
      sessionId: sessionIdentifiers.sessionId,
      uid: sessionIdentifiers.uid ?? sessionIdentifiers.userId,
      namespace: 'normal-sequence',
      deltaEpsilon: resolvedDeltaEpsilon,
    }) as NormalEvent[];

    let mutatedSequence: SimulationEvent[] = baseSequence as SimulationEvent[];
    if (anomalies.size > 0 && (anomalyRate > 0 || (Number.isFinite(anomalyCount) && (anomalyCount as number) > 0))) {
      mutatedSequence = anomalyInjector.injectAnomaly(baseSequence, {
        seed: sessionSeed,
        anomalyRate,
        anomalyCount: Number.isFinite(anomalyCount) ? (anomalyCount as number) : null,
        strategies: selectedStrategies,
        session: sessionIdentifiers,
      }) as SimulationEvent[];
    }

    const decorated = decorateSequence(mutatedSequence, {
      scenarioId,
      session: sessionIdentifiers,
    });

    const protocolAnnotated = protocolValidator.validateProtocol(decorated);
    const timeDeviationResult = timeDeviationDetector.detectTimeDeviation(
      protocolAnnotated,
      resolvedTimeDeviationOptions,
    );
    lastTimeDeviationResult = timeDeviationResult;
    const labeled = labelSequence(timeDeviationResult.events);

    for (const event of labeled) {
      events.push(event);
      if (event.session_id) {
        sessionIds.add(String(event.session_id));
      }
      if (events.length >= count) {
        break;
      }
    }

    sessionIndex += 1;
    const spacingMs = sessionSpacingSeconds * 1000;
    sessionStartTime = new Date(sessionStartTime.getTime() + Math.max(spacingMs, 1000));

    if (sessionIndex > count + 10) {
      break;
    }
  }

  const trimmedEvents = events.slice(0, count);
  const generatedAt = new Date().toISOString();

  if (lastTimeDeviationResult) {
    parameters.time_deviation_detector.threshold_seconds = lastTimeDeviationResult.thresholdSeconds;
    parameters.time_deviation_detector.diagnostics = lastTimeDeviationResult.diagnostics;
    parameters.time_deviation_detector.calibration = lastTimeDeviationResult.diagnostics.spot ?? null;
  }

  let persistenceResult: PersistSimulationResult | null = null;
  if (persist && trimmedEvents.length > 0) {
    persistenceResult = await persistSimulationRun({
      events: trimmedEvents,
      scenarioId,
      seed: resolvedSeed,
      runId: options.runId ?? null,
      outputDir: (options.outputDir as string | undefined) || config.simLogRoot,
      csvFileName: options.csvFileName as string | undefined,
      featureCsvFileName: featureCsvFileName ?? undefined,
      manifestFileName: options.manifestFileName as string | undefined,
      runMetaFileName: (options.runMetaFileName as string | undefined) || undefined,
      auditFileName: (options.auditFileName as string | undefined) || undefined,
      schemaFileName: (options.schemaFileName as string | undefined) || undefined,
      parameters,
      sessionIds: Array.from(sessionIds),
      includeFeaturesCsv,
      kid: resolvedKid,
      crypto: cryptoMetadata,
      extraMetadata: lastTimeDeviationResult
        ? {
            time_deviation: {
              method: parameters.time_deviation_detector.method,
              threshold_seconds: lastTimeDeviationResult.thresholdSeconds,
              diagnostics: lastTimeDeviationResult.diagnostics,
              calibration: lastTimeDeviationResult.diagnostics.spot
                ? {
                    u_seconds: lastTimeDeviationResult.diagnostics.spot.uSeconds,
                    xi: lastTimeDeviationResult.diagnostics.spot.xi,
                    beta: lastTimeDeviationResult.diagnostics.spot.beta,
                    p_ref: lastTimeDeviationResult.diagnostics.spot.pRef,
                    q_star: lastTimeDeviationResult.diagnostics.spot.qStar,
                    tau_t_seconds: lastTimeDeviationResult.diagnostics.spot.tauTSeconds,
                    exceedance_count: lastTimeDeviationResult.diagnostics.spot.exceedanceCount,
                    sample_count: lastTimeDeviationResult.diagnostics.spot.sampleCount,
                  }
                : null,
              post_process: {
                vote_window: parameters.time_deviation_detector.post_process.vote_window,
                vote_threshold: parameters.time_deviation_detector.post_process.vote_threshold,
                hysteresis_hold: parameters.time_deviation_detector.post_process.hysteresis_hold,
              },
            },
          }
        : undefined,
    });
  }

  const summary: SimulationSummary = {
    events: trimmedEvents.length,
    sessions: sessionIds.size,
    anomalies: buildAnomalySummary(trimmedEvents),
  };

  const response: SimulationResult = {
    scenarioId,
    generated_at: generatedAt,
    params: {
      ...parameters,
    },
    events: trimmedEvents,
    summary,
  };

  if (persistenceResult) {
    response.files = {
      csvPath: persistenceResult.csvPath,
      featuresCsvPath: persistenceResult.featuresCsvPath,
      manifestPath: persistenceResult.manifestPath,
      csvHash: persistenceResult.csvHash,
      featuresCsvHash: persistenceResult.featuresCsvHash,
      metaPath: persistenceResult.metaPath,
      runMetaPath: persistenceResult.runMetaPath,
      auditPath: persistenceResult.auditPath,
      schemaPath: persistenceResult.schemaPath,
      schemaSha256: persistenceResult.schemaSha256,
    };
    response.manifest = persistenceResult.manifest;
    response.run_meta = persistenceResult.runMeta;
  }

  const durationMs = Number(process.hrtime.bigint() - startTimeHr) / 1_000_000;
  logger.info('Simulate complete', {
    seed: resolvedSeed,
    scenario_id: scenarioId,
    events: summary.events,
    sessions: summary.sessions,
    anomalies: summary.anomalies,
    files: response.files || null,
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    time_deviation_detector: parameters.time_deviation_detector,
    feature_augmenter: parameters.feature_augmenter,
    time_anomaly: parameters.time_anomaly,
    delta_epsilon: parameters.delta_epsilon,
  });

  return response;
};

const simulationService = {
  generateScenario,
  normalizeAnomalyList,
};

export { simulationService };
export default simulationService;
