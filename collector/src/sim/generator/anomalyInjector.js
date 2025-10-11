'use strict';

const DEFAULT_OPTIONS = {
  anomalyRate: 0.1,
  anomalyCount: null,
  interval: null,
  minAnomalies: 0,
  maxAnomalies: null,
  seed: null,
  markField: '_anomalyType',
  strategies: {
    protocolViolation: {
      weight: 1,
      preLoginEvents: ['edit', 'view'],
      loginEvents: ['login'],
      logoutEvents: ['logout'],
      insertDeltaSeconds: 0,
      insertOffsetSeconds: -5,
      enableLogoutLoginLoop: true,
      logoutLoginLoopProbability: 0.4,
      loopDeltaSeconds: 2,
      preLoginFrom: 'anonymous',
      preLoginTo: 'unauthorized',
      repeatLoginFrom: 'anonymous',
      logoutFrom: 'authenticated',
      logoutTo: 'anonymous',
    },
    timeDeviation: {
      weight: 1,
      longGapSeconds: 300,
      shortGapSeconds: 0.05,
      longProbability: 0.5,
    },
    authenticationBypass: {
      weight: 1,
      unauthorizedEvents: ['edit', 'update', 'delete', 'save'],
      invalidSessionPrefix: 'invalid-session',
      invalidUserPrefix: 'spoofed-user',
      markAsUnauthenticated: true,
    },
  },
};

const STRATEGY_HANDLERS = {
  protocolViolation: (context) => applyProtocolViolation(context),
  timeDeviation: (context) => applyTimeDeviation(context),
  authenticationBypass: (context) => applyAuthenticationBypass(context),
};

const isFiniteNumber = (value) => Number.isFinite(value);

const deepClone = (value) => {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

const deepMerge = (base, overrides) => {
  if (!overrides || typeof overrides !== 'object') {
    return Array.isArray(base) ? [...base] : { ...base };
  }
  const result = Array.isArray(base) ? [...base] : { ...base };
  Object.keys(overrides).forEach((key) => {
    const overrideValue = overrides[key];
    if (overrideValue === undefined) {
      return;
    }
    const baseValue = result[key];
    if (
      overrideValue &&
      typeof overrideValue === 'object' &&
      !Array.isArray(overrideValue) &&
      baseValue &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else if (Array.isArray(overrideValue)) {
      result[key] = [...overrideValue];
    } else {
      result[key] = overrideValue;
    }
  });
  return result;
};

const normalizeSeed = (seed) => {
  if (seed === undefined || seed === null) {
    return null;
  }
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return seed >>> 0; // eslint-disable-line no-bitwise
  }
  if (typeof seed === 'string' && seed.length > 0) {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash << 5) - hash + seed.charCodeAt(index); // eslint-disable-line no-bitwise
      hash |= 0; // eslint-disable-line no-bitwise
    }
    return hash >>> 0; // eslint-disable-line no-bitwise
  }
  return null;
};

const createPrng = (seed) => {
  const normalizedSeed = normalizeSeed(seed);
  if (normalizedSeed === null) {
    return Math.random;
  }
  let state = normalizedSeed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0; // eslint-disable-line no-bitwise
    return state / 0x100000000; // eslint-disable-line no-bitwise
  };
};

const parseTimestamp = (value) => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

const formatTimestamp = (date) => {
  if (!(date instanceof Date)) {
    return null;
  }
  return date.toISOString();
};

const markAnomaly = (event, type, details, markField) => {
  event.anomaly = true;
  if (markField) {
    event[markField] = type;
  }
  if (details && typeof details === 'object') {
    const current = event._anomalyDetails && typeof event._anomalyDetails === 'object' ? event._anomalyDetails : {};
    event._anomalyDetails = { ...current, ...details };
  }
};

const shiftTimestamps = (events, startIndex, offsetMilliseconds) => {
  if (!Number.isFinite(offsetMilliseconds) || offsetMilliseconds === 0) {
    return;
  }
  for (let index = startIndex; index < events.length; index += 1) {
    const candidate = events[index];
    const parsed = parseTimestamp(candidate.timestamp);
    if (!parsed) {
      continue;
    }
    const shifted = new Date(parsed.getTime() + offsetMilliseconds);
    const formatted = formatTimestamp(shifted);
    if (formatted) {
      candidate.timestamp = formatted;
    }
  }
};

const cloneSequence = (sequence, deltaMap) =>
  sequence.map((event) => {
    const cloned = deepClone(event);
    if (!cloned || typeof cloned !== 'object') {
      return { anomaly: false };
    }
    if (cloned.anomaly !== true) {
      cloned.anomaly = false;
    }
    const delta = Number(cloned.deltaSeconds);
    if (Number.isFinite(delta)) {
      deltaMap.set(cloned, delta);
    }
    return cloned;
  });

const computeDesiredCount = (length, options) => {
  if (!Number.isInteger(length) || length <= 0) {
    return 0;
  }
  if (Number.isInteger(options.anomalyCount) && options.anomalyCount >= 0) {
    return options.anomalyCount;
  }
  if (Number.isInteger(options.interval) && options.interval > 0) {
    const fromInterval = Math.floor(length / options.interval);
    if (fromInterval > 0) {
      return applyMinMax(fromInterval, options);
    }
  }
  const ratio = Number(options.anomalyRate);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 0;
  }
  const raw = Math.ceil(length * ratio);
  return applyMinMax(raw, options);
};

const applyMinMax = (value, options) => {
  let adjusted = value;
  if (Number.isInteger(options.minAnomalies) && options.minAnomalies > 0) {
    adjusted = Math.max(adjusted, options.minAnomalies);
  }
  if (Number.isInteger(options.maxAnomalies) && options.maxAnomalies >= 0) {
    adjusted = Math.min(adjusted, options.maxAnomalies);
  }
  return Math.max(0, adjusted);
};

const buildStrategyEntries = (options) => {
  const entries = [];
  Object.keys(STRATEGY_HANDLERS).forEach((key) => {
    const defaultConfig = DEFAULT_OPTIONS.strategies[key] || {};
    const config = options.strategies[key] || {};
    const weight = Number.isFinite(config.weight) ? config.weight : defaultConfig.weight || 0;
    if (weight > 0) {
      entries.push({ key, weight });
    }
  });
  return entries;
};

const selectStrategyKey = (entries, randomFn) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return null;
  }
  const roll = randomFn() * totalWeight;
  let cumulative = 0;
  for (const entry of entries) {
    cumulative += entry.weight;
    if (roll <= cumulative + Number.EPSILON) {
      return entry.key;
    }
  }
  return entries[entries.length - 1].key;
};

const synchronizeDeltas = (events, deltaMap) => {
  let previousTimestamp = null;
  for (const event of events) {
    const currentTimestamp = parseTimestamp(event.timestamp);
    if (previousTimestamp && currentTimestamp) {
      const computedDelta = Math.max(0, (currentTimestamp.getTime() - previousTimestamp.getTime()) / 1000);
      event.deltaSeconds = computedDelta;
      const originalDelta = deltaMap.has(event) ? deltaMap.get(event) : null;
      if (Number.isFinite(originalDelta)) {
        const offset = computedDelta - originalDelta;
        const currentOffset = Number(event.deltaOffsetSeconds);
        event.deltaOffsetSeconds = Number.isFinite(currentOffset) ? currentOffset + offset : offset;
      } else if (event.deltaOffsetSeconds === undefined) {
        event.deltaOffsetSeconds = computedDelta;
      }
    } else if (!previousTimestamp && currentTimestamp) {
      if (!Number.isFinite(Number(event.deltaSeconds))) {
        event.deltaSeconds = 0;
      }
      const originalDelta = deltaMap.has(event) ? deltaMap.get(event) : null;
      if (Number.isFinite(originalDelta)) {
        const offset = event.deltaSeconds - originalDelta;
        const currentOffset = Number(event.deltaOffsetSeconds);
        event.deltaOffsetSeconds = Number.isFinite(currentOffset) ? currentOffset + offset : offset;
      } else if (event.deltaOffsetSeconds === undefined) {
        event.deltaOffsetSeconds = event.deltaSeconds;
      }
    } else if (!currentTimestamp) {
      if (!Number.isFinite(Number(event.deltaSeconds))) {
        event.deltaSeconds = 0;
      }
      if (event.deltaOffsetSeconds === undefined) {
        event.deltaOffsetSeconds = 0;
      }
    }
    if (deltaMap.has(event)) {
      deltaMap.delete(event);
    }
    if (currentTimestamp) {
      previousTimestamp = currentTimestamp;
    }
  }
};

const applyProtocolViolation = ({ events, options, randomFn, markField, deltaMap }) => {
  if (!Array.isArray(events) || events.length === 0) {
    return false;
  }
  const config = options.strategies.protocolViolation;
  const loginEvents = new Set(
    Array.isArray(config.loginEvents) && config.loginEvents.length > 0 ? config.loginEvents : ['login']
  );
  const logoutEvents = new Set(
    Array.isArray(config.logoutEvents) && config.logoutEvents.length > 0 ? config.logoutEvents : ['logout']
  );
  const loginIndex = events.findIndex((event) => loginEvents.has(event.event));
  if (loginIndex === -1) {
    return false;
  }

  const shouldLoop =
    config.enableLogoutLoginLoop !== false && randomFn() < Number(config.logoutLoginLoopProbability || 0);

  if (shouldLoop && loginIndex < events.length) {
    const baseEvent = events[loginIndex];
    const baseTimestamp = parseTimestamp(baseEvent.timestamp) || new Date();
    const loopDelta = Number(config.loopDeltaSeconds);
    const deltaSeconds = Number.isFinite(loopDelta) && loopDelta > 0 ? loopDelta : 2;

    const logoutEvent = deepClone(baseEvent);
    logoutEvent.event = Array.from(logoutEvents)[0] || 'logout';
    logoutEvent.from = config.logoutFrom || 'authenticated';
    logoutEvent.to = config.logoutTo || 'anonymous';
    logoutEvent.timestamp = formatTimestamp(new Date(baseTimestamp.getTime() + deltaSeconds * 1000));
    logoutEvent.deltaSeconds = deltaSeconds;
    logoutEvent.probability = 0;
    markAnomaly(logoutEvent, 'protocolViolation', { reason: 'logoutLoginLoop' }, markField);

    const repeatLogin = deepClone(baseEvent);
    repeatLogin.event = Array.from(loginEvents)[0] || 'login';
    repeatLogin.from = config.repeatLoginFrom || 'anonymous';
    repeatLogin.to = baseEvent.to || 'authenticated';
    repeatLogin.timestamp = formatTimestamp(new Date(baseTimestamp.getTime() + deltaSeconds * 2000));
    repeatLogin.deltaSeconds = deltaSeconds;
    repeatLogin.probability = 0;
    markAnomaly(repeatLogin, 'protocolViolation', { reason: 'logoutLoginLoop' }, markField);

    const insertionIndex = loginIndex + 1;
    events.splice(insertionIndex, 0, logoutEvent, repeatLogin);
    deltaMap.set(logoutEvent, 0);
    deltaMap.set(repeatLogin, 0);

    shiftTimestamps(events, insertionIndex + 2, deltaSeconds * 2000);
    return true;
  }

  const referenceEvent = events[loginIndex];
  const preLoginEvents = Array.isArray(config.preLoginEvents) && config.preLoginEvents.length > 0
    ? config.preLoginEvents
    : ['edit', 'view'];
  const selected = preLoginEvents[Math.floor(randomFn() * preLoginEvents.length)] || 'edit';
  const insertOffsetSeconds = Number(config.insertOffsetSeconds);
  const insertDeltaSeconds = Number(config.insertDeltaSeconds);
  const offsetSeconds = Number.isFinite(insertOffsetSeconds) ? insertOffsetSeconds : -5;
  const deltaSeconds = Number.isFinite(insertDeltaSeconds) && insertDeltaSeconds >= 0 ? insertDeltaSeconds : 0;
  const referenceTimestamp = parseTimestamp(referenceEvent.timestamp) || new Date();
  const insertedTimestamp = new Date(referenceTimestamp.getTime() + offsetSeconds * 1000);

  const inserted = deepClone(referenceEvent);
  inserted.event = selected;
  inserted.from = config.preLoginFrom || 'anonymous';
  inserted.to = config.preLoginTo || referenceEvent.from || 'unauthorized';
  inserted.timestamp = formatTimestamp(insertedTimestamp) || referenceEvent.timestamp;
  inserted.deltaSeconds = deltaSeconds;
  inserted.probability = 0;
  markAnomaly(inserted, 'protocolViolation', { reason: 'preLoginOperation' }, markField);

  events.splice(loginIndex, 0, inserted);
  deltaMap.set(inserted, 0);
  return true;
};

const applyTimeDeviation = ({ events, options, randomFn, markField }) => {
  if (!Array.isArray(events) || events.length < 2) {
    return false;
  }
  const config = options.strategies.timeDeviation;
  const candidateIndices = [];
  for (let index = 1; index < events.length; index += 1) {
    const current = events[index];
    const previous = events[index - 1];
    if (parseTimestamp(current.timestamp) && parseTimestamp(previous.timestamp)) {
      candidateIndices.push(index);
    }
  }
  if (candidateIndices.length === 0) {
    return false;
  }
  const chosenIndex = candidateIndices[Math.floor(randomFn() * candidateIndices.length)];
  const target = events[chosenIndex];
  const previous = events[chosenIndex - 1];
  const previousTimestamp = parseTimestamp(previous.timestamp);
  if (!previousTimestamp) {
    return false;
  }

  const longProbability = Number(config.longProbability);
  const useLongGap = Number.isFinite(longProbability) ? randomFn() < longProbability : randomFn() < 0.5;
  const longGap = Number(config.longGapSeconds);
  const shortGap = Number(config.shortGapSeconds);
  const desiredDelta = useLongGap
    ? (Number.isFinite(longGap) && longGap > 0 ? longGap : 300)
    : Math.max(0, Number.isFinite(shortGap) ? shortGap : 0.05);

  const newTimestamp = new Date(previousTimestamp.getTime() + desiredDelta * 1000);
  const currentTimestamp = parseTimestamp(target.timestamp) || newTimestamp;
  const deltaShift = newTimestamp.getTime() - currentTimestamp.getTime();

  target.timestamp = formatTimestamp(newTimestamp) || target.timestamp;
  target.deltaSeconds = desiredDelta;
  markAnomaly(target, 'timeDeviation', { mode: useLongGap ? 'long' : 'short', desiredDelta }, markField);

  if (deltaShift !== 0) {
    shiftTimestamps(events, chosenIndex + 1, deltaShift);
  }
  return true;
};

const applyAuthenticationBypass = ({ events, options, randomFn, markField }) => {
  if (!Array.isArray(events) || events.length === 0) {
    return false;
  }
  const config = options.strategies.authenticationBypass;
  const unauthorizedEvents = new Set(
    Array.isArray(config.unauthorizedEvents) && config.unauthorizedEvents.length > 0
      ? config.unauthorizedEvents.map((item) => String(item).toLowerCase())
      : []
  );

  const candidates = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => {
      if (!event || typeof event !== 'object') {
        return false;
      }
      if (unauthorizedEvents.size === 0) {
        return true;
      }
      if (!event.event) {
        return false;
      }
      return unauthorizedEvents.has(String(event.event).toLowerCase());
    });

  const selectedEntry =
    candidates.length > 0
      ? candidates[Math.floor(randomFn() * candidates.length)]
      : { event: events[Math.floor(randomFn() * events.length)], index: Math.floor(randomFn() * events.length) };

  if (!selectedEntry || !selectedEntry.event) {
    return false;
  }

  const target = selectedEntry.event;
  const suffix = Math.floor(randomFn() * 0xfffff).toString(16);
  const invalidSessionPrefix = config.invalidSessionPrefix || 'invalid-session';
  const invalidUserPrefix = config.invalidUserPrefix || 'spoofed-user';

  if (typeof target.session_id === 'string' && target.session_id.length > 0) {
    target.session_id = `${invalidSessionPrefix}-${suffix}`;
  } else {
    target.session_id = `${invalidSessionPrefix}-${suffix}`;
  }

  if (typeof target.user_id === 'string' && target.user_id.length > 0) {
    target.user_id = `${invalidUserPrefix}-${suffix}`;
  } else {
    target.user_id = `${invalidUserPrefix}-${suffix}`;
  }

  if (config.markAsUnauthenticated) {
    target.authenticated = false;
  }
  if (!target.metadata || typeof target.metadata !== 'object') {
    target.metadata = {};
  }
  target.metadata.auth = {
    ...(target.metadata.auth || {}),
    status: 'invalid',
    reason: 'unauthorizedOperation',
  };
  target.authTokenValid = false;
  target.sessionSpoofed = true;

  markAnomaly(target, 'authenticationBypass', { reason: 'unauthorizedOperation' }, markField);
  return true;
};

const injectAnomaly = (sequence, userOptions = {}) => {
  if (!Array.isArray(sequence)) {
    return [];
  }
  if (sequence.length === 0) {
    return [];
  }

  const mergedOptions = deepMerge(DEFAULT_OPTIONS, userOptions || {});
  const randomFn = createPrng(mergedOptions.seed);
  const deltaMap = new WeakMap();
  const mutated = cloneSequence(sequence, deltaMap);

  const desiredCount = computeDesiredCount(sequence.length, mergedOptions);
  if (desiredCount <= 0) {
    synchronizeDeltas(mutated, deltaMap);
    return mutated;
  }

  const strategyEntries = buildStrategyEntries(mergedOptions);
  if (strategyEntries.length === 0) {
    synchronizeDeltas(mutated, deltaMap);
    return mutated;
  }

  const context = {
    events: mutated,
    options: mergedOptions,
    randomFn,
    markField: mergedOptions.markField,
    deltaMap,
  };

  let appliedCount = 0;
  let attempts = 0;
  const maxAttempts = Math.max(desiredCount * 5, 10);
  while (appliedCount < desiredCount && attempts < maxAttempts) {
    attempts += 1;
    const strategyKey = selectStrategyKey(strategyEntries, randomFn);
    if (!strategyKey) {
      break;
    }
    const handler = STRATEGY_HANDLERS[strategyKey];
    if (!handler) {
      continue;
    }
    const applied = handler(context);
    if (applied) {
      appliedCount += 1;
    }
  }

  synchronizeDeltas(mutated, deltaMap);
  return mutated;
};

module.exports = {
  injectAnomaly,
};
