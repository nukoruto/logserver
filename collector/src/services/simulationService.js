'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../utils/logger');
const sim = require('../sim');
const { buildAnomalySummary } = require('../sim/persistence/simWriter');

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

const EVENT_BLUEPRINTS = {
  login: { method: 'POST', path: '/auth/login', opCategory: 'AUTH', baseLatency: 140, successStatus: 200 },
  browse: { method: 'GET', path: '/workspace/feed', opCategory: 'READ', baseLatency: 95, successStatus: 200 },
  view: { method: 'GET', path: '/workspace/feed', opCategory: 'READ', baseLatency: 90, successStatus: 200 },
  edit: { method: 'POST', path: '/workspace/edit', opCategory: 'UPDATE', baseLatency: 130, successStatus: 200 },
  save: { method: 'PUT', path: '/workspace/save', opCategory: 'UPDATE', baseLatency: 150, successStatus: 200 },
  delete: { method: 'DELETE', path: '/workspace/delete', opCategory: 'UPDATE', baseLatency: 170, successStatus: 403 },
  logout: { method: 'POST', path: '/auth/logout', opCategory: 'AUTH', baseLatency: 100, successStatus: 200 },
  __default: { method: 'POST', path: '/workspace/unknown', opCategory: 'READ', baseLatency: 120, successStatus: 200 },
};

const STRATEGY_ALIASES = {
  protocol: 'protocolViolation',
  'protocol_violation': 'protocolViolation',
  protocolviolation: 'protocolViolation',
  time: 'timeDeviation',
  'time_deviation': 'timeDeviation',
  timedeviation: 'timeDeviation',
  auth: 'authenticationBypass',
  authentication: 'authenticationBypass',
  'authentication_bypass': 'authenticationBypass',
};

const normalizeString = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const normalizeSeedInput = (seed) => {
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

const generateSeed = () => crypto.randomBytes(12).toString('hex');

const resolveSeed = (seed) => {
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

const parsePositiveNumber = (candidate, fallback) => {
  const value = Number(candidate);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
};

const parseNonNegativeNumber = (candidate, fallback) => {
  const value = Number(candidate);
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
};

const parseBoolean = (candidate, fallback) => {
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

const normalizeAnomalyList = (input) => {
  if (!input) {
    return new Set();
  }
  const list = Array.isArray(input) ? input : String(input).split(',');
  const normalized = list
    .map((item) => normalizeString(item).toLowerCase())
    .filter((item) => item.length > 0)
    .map((item) => STRATEGY_ALIASES[item] || item);
  return new Set(normalized.filter((item) => ['protocolViolation', 'timeDeviation', 'authenticationBypass'].includes(item)));
};

const buildStrategyOverrides = (selectedStrategies) => ({
  protocolViolation: { weight: selectedStrategies.has('protocolViolation') ? 1 : 0 },
  timeDeviation: { weight: selectedStrategies.has('timeDeviation') ? 1 : 0 },
  authenticationBypass: { weight: selectedStrategies.has('authenticationBypass') ? 1 : 0 },
});

const parseStartTime = (candidate) => {
  if (!candidate) {
    return new Date();
  }
  if (candidate instanceof Date) {
    return new Date(candidate.getTime());
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid startTime provided: ${candidate}`);
  }
  return parsed;
};

const createSessionIdentifiers = (seed, index) => {
  const base = normalizeString(seed) || 'sim';
  const suffix = (index + 1).toString().padStart(3, '0');
  return {
    sessionId: `sess-${base}-${suffix}`,
    userId: `user-${base}-${suffix}`,
    uid: `uid-${base}-${(index + 1).toString(16).padStart(3, '0')}`,
  };
};

const resolveBlueprint = (eventName) => {
  const key = normalizeString(eventName).toLowerCase();
  if (key && EVENT_BLUEPRINTS[key]) {
    return EVENT_BLUEPRINTS[key];
  }
  return EVENT_BLUEPRINTS.__default;
};

const deriveStatus = (blueprint, anomalyTag) => {
  if (!anomalyTag) {
    return blueprint.successStatus || 200;
  }
  const normalized = String(anomalyTag).toLowerCase();
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

const deriveLatency = (blueprint, deltaSeconds, index) => {
  const base = Number.isFinite(blueprint.baseLatency) ? blueprint.baseLatency : 120;
  const deltaComponent = Number.isFinite(deltaSeconds) ? deltaSeconds * 40 : 0;
  return Math.max(20, Math.round(base + deltaComponent + (index % 17)));
};

const cloneMetadata = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
};

const decorateEvent = ({
  event,
  scenarioId,
  session,
  index,
}) => {
  const blueprint = resolveBlueprint(event.event);
  const metadata = cloneMetadata(event.metadata);
  metadata.scenario = {
    id: scenarioId,
    from: event.from || null,
    to: event.to || null,
    probability: Number.isFinite(event.probability) ? event.probability : null,
  };
  metadata.sequence_index = index;
  if (!metadata.op_category && blueprint.opCategory) {
    metadata.op_category = blueprint.opCategory;
  }

  const anomalyTag = normalizeString(event._anomalyType || event.anomaly_type || event.anomalyType);
  const deltaSeconds = Number(event.deltaSeconds);

  const record = {
    timestamp: event.timestamp,
    session_id: normalizeString(event.session_id) || session.sessionId,
    user_id: normalizeString(event.user_id) || session.userId,
    uid: normalizeString(event.uid) || session.uid,
    event: event.event,
    method: event.method || blueprint.method,
    path: event.path || blueprint.path,
    status: Number.isFinite(event.status) ? Math.trunc(event.status) : deriveStatus(blueprint, anomalyTag),
    latency_ms: Number.isFinite(event.latency_ms) ? Math.round(event.latency_ms) : deriveLatency(blueprint, deltaSeconds, index),
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
    record.timeDeviationObservedDeltaSeconds = event.timeDeviationObservedDeltaSeconds;
    record.timeDeviationThresholdSeconds = event.timeDeviationThresholdSeconds;
    record.timeDeviationScore = event.timeDeviationScore;
  }

  if (anomalyTag) {
    record._anomalyType = anomalyTag;
    record.anomaly = true;
  } else if (event.anomaly === true) {
    record.anomaly = true;
  }

  return record;
};

const decorateSequence = (events, context) => {
  const decorated = [];
  for (let index = 0; index < events.length; index += 1) {
    decorated.push(
      decorateEvent({
        event: events[index],
        scenarioId: context.scenarioId,
        session: context.session,
        index,
      }),
    );
  }
  return decorated;
};

const defaultParameters = (input) => ({
  count: input.count,
  anomalies: Array.from(input.anomalies || []),
  seed: input.seed || null,
  seed_source: input.seedSource || null,
  scenario_path: input.scenarioPath || null,
  anomaly_rate: input.anomalyRate,
  anomaly_count: input.anomalyCount,
  session_spacing_seconds: input.sessionSpacingSeconds,
  persist: input.persist,
  max_steps: input.maxSteps,
  time_deviation_detector: {
    method: input.timeDeviationMethod || 'quantile',
    quantile: input.timeDeviationQuantile || 0.99,
    min_samples: input.timeDeviationMinSamples || 5,
  },
  protocol_validator: {
    enabled: true,
  },
});

const generateScenario = async (options = {}) => {
  const count = Number.isInteger(options.count) && options.count > 0 ? options.count : DEFAULT_EVENT_COUNT;
  const maxSteps = Number.isInteger(options.maxSteps) && options.maxSteps > 0 ? options.maxSteps : DEFAULT_MAX_STEPS;
  const sessionSpacingSeconds = parsePositiveNumber(options.sessionSpacingSeconds, DEFAULT_SESSION_SPACING_SECONDS);
  const persist = parseBoolean(options.persist, true);
  const scenarioPath = options.scenarioPath || options.scenarioFile || null;
  const anomalyRate = options.anomalyRate !== undefined ? parseNonNegativeNumber(options.anomalyRate, DEFAULT_ANOMALY_RATE) : DEFAULT_ANOMALY_RATE;
  const anomalyCount = options.anomalyCount !== undefined ? parseNonNegativeNumber(options.anomalyCount, null) : null;
  const anomalies = normalizeAnomalyList(options.anomalies);

  const scenarioDefinition = scenario.loadScenario(scenarioPath);
  const scenarioId = normalizeString(scenarioDefinition.id) || 'default-flow';
  const scenarioVersion = scenarioDefinition.version || null;

  const baseStartTime = parseStartTime(options.startTime);
  const seedResolution = resolveSeed(options.seed);
  const resolvedSeed = seedResolution.value;
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
    timeDeviationMethod: 'quantile',
    timeDeviationQuantile: 0.99,
    timeDeviationMinSamples: 5,
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
  });

  const events = [];
  const sessionIds = new Set();
  let sessionIndex = 0;
  let sessionStartTime = new Date(baseStartTime.getTime());

  while (events.length < count) {
    const sessionSeed = `${resolvedSeed}:${sessionIndex}`;
    const sessionIdentifiers = createSessionIdentifiers(resolvedSeed || scenarioId, sessionIndex);

    const baseSequence = normalGenerator.generateNormalSequence({
      scenario: scenarioDefinition,
      seed: sessionSeed,
      startTime: sessionStartTime,
      maxSteps,
    });

    let mutatedSequence = baseSequence;
    if (anomalies.size > 0 && (anomalyRate > 0 || (Number.isFinite(anomalyCount) && anomalyCount > 0))) {
      mutatedSequence = anomalyInjector.injectAnomaly(baseSequence, {
        seed: sessionSeed,
        anomalyRate,
        anomalyCount: Number.isFinite(anomalyCount) ? anomalyCount : null,
        strategies: selectedStrategies,
      });
    }

    const decorated = decorateSequence(mutatedSequence, {
      scenarioId,
      session: sessionIdentifiers,
    });

    const protocolAnnotated = protocolValidator.validateProtocol(decorated);
    const timeAnnotated = timeDeviationDetector.detectTimeDeviation(protocolAnnotated);
    const labeled = labelSequence(timeAnnotated);

    for (const event of labeled) {
      events.push(event);
      sessionIds.add(event.session_id);
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

  let persistenceResult = null;
  if (persist && trimmedEvents.length > 0) {
    persistenceResult = await persistSimulationRun({
      events: trimmedEvents,
      scenarioId,
      seed: resolvedSeed,
      runId: options.runId,
      outputDir: options.outputDir || config.simLogRoot,
      csvFileName: options.csvFileName,
      manifestFileName: options.manifestFileName,
      parameters,
      sessionIds: Array.from(sessionIds),
    });
  }

  const summary = {
    events: trimmedEvents.length,
    sessions: sessionIds.size,
    anomalies: buildAnomalySummary(trimmedEvents),
  };

  const response = {
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
  });

  return response;
};

module.exports = {
  generateScenario,
  normalizeAnomalyList,
};
