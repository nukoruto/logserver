import * as crypto from 'node:crypto';
import config from '../config';
import logger from '../utils/logger';
import sim from '../sim';
import {
  buildAnomalySummary,
  DEFAULT_FEATURE_AUGMENTER,
  resolveFeatureAugmenterOptions,
  cloneFeatureAugmenterOptions,
} from '../sim/persistence/simWriter';
import type { FeatureAugmenterOptions } from '../sim/persistence/simWriter';
import type { ScenarioDefinition } from '../sim/scenario';
import type { NormalEvent } from '../sim/generator/normalGenerator';
import type { PersistSimulationResult } from '../sim/persistence/simWriter';
import type {
  TimeDeviationOptions,
  TimeDeviationDiagnostics,
  TimeDeviationDetectionResult,
} from '../sim/detector/timeDeviationDetector';

type StrategyName = 'protocolViolation' | 'timeDeviation' | 'authenticationBypass';

type StrategyOverrides = Record<StrategyName, { weight: number }>;

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
  status?: number;
  latency_ms?: number;
  delta_t?: number;
  timestamp?: string;
  timestamp_utc?: string;
  deltaSeconds?: number | null;
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
  manifestPath: string;
  hash: string;
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
  manifestFileName?: string;
  sessionSpacingSeconds?: number;
  scenarioPath?: string | null;
  scenarioFile?: string | null;
  startTime?: Date | string | null;
  timeDeviation?: Partial<TimeDeviationOptions> | null;
  featureAugmenter?: Partial<FeatureAugmenterOptions> | Record<string, unknown> | null;
  feature_augmenter?: Partial<FeatureAugmenterOptions> | Record<string, unknown> | null;
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
  };
  protocol_validator: {
    enabled: boolean;
  };
}

export interface SimulationResult {
  scenarioId: string;
  generated_at: string;
  params: SimulationParameters;
  events: SimulationEvent[];
  summary: SimulationSummary;
  files?: SimulationFiles;
  manifest?: Record<string, unknown>;
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
  featureAugmenter: FeatureAugmenterOptions;
  timeDeviationMethod: string;
  timeDeviationQuantile: number | null;
  timeDeviationMinSamples: number;
  timeDeviationFallback: number | null;
}

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
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

const buildStrategyOverrides = (selectedStrategies: NormalizedAnomalyList): StrategyOverrides => ({
  protocolViolation: { weight: selectedStrategies.has('protocolViolation') ? 1 : 0 },
  timeDeviation: { weight: selectedStrategies.has('timeDeviation') ? 1 : 0 },
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
  return {
    sessionId: `sess-${base}-${suffix}`,
    userId: `user-${base}-${suffix}`,
    uid: `uid-${base}-${(index + 1).toString(16).padStart(3, '0')}`,
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
  if (!metadata.op_category && blueprint.opCategory) {
    metadata.op_category = blueprint.opCategory;
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
    latency_ms: Number.isFinite(event.latency_ms)
      ? Math.round(Number(event.latency_ms))
      : deriveLatency(blueprint, Number.isFinite(deltaSeconds) ? deltaSeconds : undefined, index),
    deltaSeconds: Number.isFinite(deltaSeconds) ? deltaSeconds : undefined,
    metadata,
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

const decorateSequence = (events: SimulationEvent[], context: { scenarioId: string; session: SessionIdentifiers }): SimulationEvent[] => {
  const decorated: SimulationEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    decorated.push(
      decorateEvent({
        event: events[index],
        scenarioId: context.scenarioId,
        session: context.session,
        index,
      })
    );
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
  },
  protocol_validator: {
    enabled: true,
  },
});

export const generateScenario = async (options: GenerateScenarioOptions = {}): Promise<SimulationResult> => {
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
  const resolvedTimeDeviationOptions: TimeDeviationOptions = {
    ...(timeDeviationInput ?? {}),
    method: resolvedTimeDeviationMethod,
    quantile: resolvedTimeDeviationQuantile,
    minSamples: resolvedTimeDeviationMinSamples,
    fallbackThresholdSeconds: resolvedTimeDeviationFallback,
    thresholdSeconds: resolvedTimeDeviationThreshold,
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
    featureAugmenter: resolvedFeatureAugmenter,
    timeDeviationMethod: resolvedTimeDeviationMethod,
    timeDeviationQuantile: parameterQuantile,
    timeDeviationMinSamples: resolvedTimeDeviationMinSamples,
    timeDeviationFallback: resolvedTimeDeviationFallback,
  });

  const selectedStrategies = buildStrategyOverrides(anomalies);
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
    time_deviation_detector: parameters.time_deviation_detector,
    feature_augmenter: parameters.feature_augmenter,
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
    }) as NormalEvent[];

    let mutatedSequence: SimulationEvent[] = baseSequence as SimulationEvent[];
    if (anomalies.size > 0 && (anomalyRate > 0 || (Number.isFinite(anomalyCount) && (anomalyCount as number) > 0))) {
      mutatedSequence = anomalyInjector.injectAnomaly(baseSequence, {
        seed: sessionSeed,
        anomalyRate,
        anomalyCount: Number.isFinite(anomalyCount) ? (anomalyCount as number) : null,
        strategies: selectedStrategies,
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
      manifestFileName: options.manifestFileName as string | undefined,
      parameters,
      sessionIds: Array.from(sessionIds),
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
      manifestPath: persistenceResult.manifestPath,
      hash: persistenceResult.hash,
    };
    response.manifest = persistenceResult.manifest;
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
  });

  return response;
};

const simulationService = {
  generateScenario,
  normalizeAnomalyList,
};

export { simulationService };
export default simulationService;
