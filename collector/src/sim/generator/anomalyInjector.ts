import type { SimulationEvent } from '../../services/simulationService';
import { DEFAULT_DELTA_EPSILON } from './normalGenerator';

export type StrategyConfig = Record<string, unknown>;

export type TimeDeviationMode = 'auto' | 'propagate' | 'local';

export interface SessionContext {
  sessionId?: string | null;
  userId?: string | null;
  uid?: string | null;
}

export interface AnomalyInjectionOptions extends Record<string, unknown> {
  anomalyRate?: number;
  anomalyCount?: number | null;
  interval?: number | null;
  minAnomalies?: number;
  maxAnomalies?: number | null;
  seed?: number | string | null;
  markField?: string | null;
  strategies?: Record<string, StrategyConfig> | Iterable<string> | null;
  session?: SessionContext | null;
}

interface StrategyEntry {
  key: string;
  weight: number;
}

interface MutationContext {
  events: SimulationEvent[];
  options: NormalizedOptions;
  randomFn: () => number;
  markField: string | null;
  deltaMap: WeakMap<SimulationEvent, number>;
  session: SessionContext | null;
}

interface NormalizedOptions extends AnomalyInjectionOptions {
  anomalyRate: number;
  anomalyCount: number | null;
  interval: number | null;
  minAnomalies: number;
  maxAnomalies: number | null;
  seed: number | string | null;
  markField: string | null;
  strategies: Record<string, StrategyConfig>;
  session: SessionContext | null;
}

const DEFAULT_OPTIONS: NormalizedOptions = {
  anomalyRate: 0.1,
  anomalyCount: null,
  interval: null,
  minAnomalies: 0,
  maxAnomalies: null,
  seed: null,
  markField: '_anomalyType',
  session: null,
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
      mode: 'auto',
      propagateWeight: 0.7,
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

const MIN_ANOMALY_DELTA = DEFAULT_DELTA_EPSILON;
const DEFAULT_PROPAGATE_WEIGHT = 0.7;

type StrategyHandler = (context: MutationContext) => boolean;

const STRATEGY_HANDLERS: Record<string, StrategyHandler> = {
  protocolViolation: (context) => applyProtocolViolation(context),
  timeDeviation: (context) => applyTimeDeviation(context),
  authenticationBypass: (context) => applyAuthenticationBypass(context),
};

const deepClone = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const deepMerge = <T extends Record<string, unknown>>(base: T, overrides: Record<string, unknown> | undefined): T => {
  if (!overrides || typeof overrides !== 'object') {
    return { ...base } as T;
  }
  const result: Record<string, unknown> = { ...base };
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
      result[key] = deepMerge(baseValue as Record<string, unknown>, overrideValue as Record<string, unknown>);
    } else if (Array.isArray(overrideValue)) {
      result[key] = [...overrideValue];
    } else {
      result[key] = overrideValue;
    }
  });
  return result as T;
};

const normalizeSeed = (seed: unknown): number | null => {
  if (seed === undefined || seed === null) {
    return null;
  }
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return seed >>> 0;
  }
  if (typeof seed === 'string' && seed.length > 0) {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash << 5) - hash + seed.charCodeAt(index);
      hash |= 0;
    }
    return hash >>> 0;
  }
  return null;
};

const createPrng = (seed: unknown): (() => number) => {
  const normalizedSeed = normalizeSeed(seed);
  if (normalizedSeed === null) {
    return Math.random;
  }
  let state = normalizedSeed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
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

const formatTimestamp = (date: Date | null): string | null => {
  if (!date) {
    return null;
  }
  return date.toISOString();
};

const toIdString = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return fallback;
};

const resolvePropagationSeed = (
  session: SessionContext | null,
  event: SimulationEvent,
  index: number,
  globalSeed: number | string | null,
): string => {
  const sessionId = toIdString(session?.sessionId ?? event.session_id, 'sess-unknown');
  const uid = toIdString(session?.uid ?? event.uid ?? event.user_id, 'uid-unknown');
  const baseSeed = `${sessionId}|${uid}|${index}`;
  const seedPrefix =
    typeof globalSeed === 'string' && globalSeed.length > 0
      ? String(globalSeed)
      : typeof globalSeed === 'number' && Number.isFinite(globalSeed)
        ? String(globalSeed)
        : 'time-deviation';
  return `${seedPrefix}|${baseSeed}`;
};

const normalizePropagationWeight = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_PROPAGATE_WEIGHT;
  }
  if (numeric <= 0) {
    return 0;
  }
  if (numeric >= 1) {
    return 1;
  }
  return numeric;
};

const normalizeTimeDeviationMode = (value: unknown): TimeDeviationMode | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'propagate' || normalized === 'local' || normalized === 'auto') {
    return normalized;
  }
  return null;
};

const selectPropagationMode = (
  config: Record<string, unknown>,
  events: SimulationEvent[],
  options: NormalizedOptions,
  session: SessionContext | null,
  index: number,
): { mode: 'propagate' | 'local'; weight: number } => {
  const explicitMode =
    normalizeTimeDeviationMode(config.mode) ||
    normalizeTimeDeviationMode((config as Record<string, unknown>).propagationMode);
  if (explicitMode === 'propagate' || explicitMode === 'local') {
    return { mode: explicitMode, weight: normalizePropagationWeight(config.propagateWeight) };
  }

  const weights = (config.weights as Record<string, unknown> | undefined) ?? {};
  const propagateWeight = normalizePropagationWeight(
    config.propagateWeight ?? weights.propagate ?? (config as Record<string, unknown>).propagateProbability,
  );
  const seed = resolvePropagationSeed(session, events[index], index, options.seed);
  const rng = createPrng(seed);
  const roll = rng();
  return {
    mode: roll < propagateWeight ? 'propagate' : 'local',
    weight: propagateWeight,
  };
};

const markAnomaly = (
  event: SimulationEvent,
  type: string,
  details: Record<string, unknown> | null,
  markField: string | null,
): void => {
  event.anomaly = true;
  if (markField) {
    event[markField] = type;
  }
  if (details && typeof details === 'object') {
    const current =
      event._anomalyDetails && typeof event._anomalyDetails === 'object'
        ? (event._anomalyDetails as Record<string, unknown>)
        : {};
    event._anomalyDetails = { ...current, ...details };
  }
};

const shiftTimestamps = (
  events: SimulationEvent[],
  startIndex: number,
  offsetMilliseconds: number,
): void => {
  if (!Number.isFinite(offsetMilliseconds) || offsetMilliseconds === 0) {
    return;
  }
  for (let index = startIndex; index < events.length; index += 1) {
    const candidate = events[index];
    const parsed = parseTimestamp(candidate?.timestamp);
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

const cloneSequence = (
  sequence: readonly SimulationEvent[],
  deltaMap: WeakMap<SimulationEvent, number>,
): SimulationEvent[] =>
  sequence.map((event) => {
    const cloned = deepClone(event);
    if (!cloned || typeof cloned !== 'object') {
      return { anomaly: false } as SimulationEvent;
    }
    if (cloned.anomaly !== true) {
      cloned.anomaly = false;
    }
    const delta = Number((cloned as Record<string, unknown>).deltaSeconds);
    if (Number.isFinite(delta)) {
      deltaMap.set(cloned, delta);
    }
    return cloned;
  });

const computeDesiredCount = (length: number, options: NormalizedOptions): number => {
  if (!Number.isInteger(length) || length <= 0) {
    return 0;
  }
  if (Number.isInteger(options.anomalyCount) && (options.anomalyCount as number) >= 0) {
    return options.anomalyCount as number;
  }
  if (Number.isInteger(options.interval) && (options.interval as number) > 0) {
    const fromInterval = Math.floor(length / (options.interval as number));
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

const applyMinMax = (value: number, options: NormalizedOptions): number => {
  let adjusted = value;
  if (Number.isInteger(options.minAnomalies) && (options.minAnomalies as number) > 0) {
    adjusted = Math.max(adjusted, options.minAnomalies as number);
  }
  if (Number.isInteger(options.maxAnomalies) && (options.maxAnomalies as number) >= 0) {
    adjusted = Math.min(adjusted, options.maxAnomalies as number);
  }
  return Math.max(0, adjusted);
};

const buildStrategyEntries = (options: NormalizedOptions): StrategyEntry[] => {
  const entries: StrategyEntry[] = [];
  Object.keys(STRATEGY_HANDLERS).forEach((key) => {
    const defaultConfig = DEFAULT_OPTIONS.strategies[key];
    const config = (options.strategies && options.strategies[key]) || defaultConfig || {};
    const weightCandidate = (config?.weight ?? defaultConfig?.weight ?? 0) as number;
    const weight = Number.isFinite(weightCandidate) ? weightCandidate : 0;
    if (weight > 0) {
      entries.push({ key, weight });
    }
  });
  return entries;
};

const selectStrategyKey = (entries: readonly StrategyEntry[], randomFn: () => number): string | null => {
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

const synchronizeDeltas = (
  events: SimulationEvent[],
  deltaMap: WeakMap<SimulationEvent, number>,
): void => {
  let previousTimestamp: Date | null = null;
  for (const event of events) {
    const currentTimestamp = parseTimestamp(event.timestamp);
    if (previousTimestamp && currentTimestamp) {
      const computedDelta = Math.max(
        MIN_ANOMALY_DELTA,
        (currentTimestamp.getTime() - previousTimestamp.getTime()) / 1000,
      );
      event.deltaSeconds = computedDelta;
      const originalDelta = deltaMap.has(event) ? deltaMap.get(event) : null;
      if (Number.isFinite(originalDelta)) {
        const offset = computedDelta - (originalDelta as number);
        const currentOffset = Number(event.deltaOffsetSeconds);
        event.deltaOffsetSeconds = Number.isFinite(currentOffset) ? currentOffset + offset : offset;
      } else if (event.deltaOffsetSeconds === undefined) {
        event.deltaOffsetSeconds = computedDelta;
      }
    } else if (!previousTimestamp && currentTimestamp) {
      if (!Number.isFinite(Number(event.deltaSeconds))) {
        event.deltaSeconds = MIN_ANOMALY_DELTA;
      }
      const originalDelta = deltaMap.has(event) ? deltaMap.get(event) : null;
      if (Number.isFinite(originalDelta)) {
        const offset = (event.deltaSeconds as number) - (originalDelta as number);
        const currentOffset = Number(event.deltaOffsetSeconds);
        event.deltaOffsetSeconds = Number.isFinite(currentOffset) ? currentOffset + offset : offset;
      } else if (event.deltaOffsetSeconds === undefined) {
        event.deltaOffsetSeconds = event.deltaSeconds as number;
      }
    } else if (!currentTimestamp) {
      if (!Number.isFinite(Number(event.deltaSeconds))) {
        event.deltaSeconds = MIN_ANOMALY_DELTA;
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

const applyProtocolViolation = ({ events, options, randomFn, markField, deltaMap }: MutationContext): boolean => {
  if (!Array.isArray(events) || events.length === 0) {
    return false;
  }
  const config = (options.strategies.protocolViolation || {}) as Record<string, unknown>;
  const loginEvents = new Set(
    Array.isArray(config.loginEvents) && config.loginEvents.length > 0
      ? (config.loginEvents as unknown[]).map((item) => String(item))
      : ['login'],
  );
  const logoutEvents = new Set(
    Array.isArray(config.logoutEvents) && config.logoutEvents.length > 0
      ? (config.logoutEvents as unknown[]).map((item) => String(item))
      : ['logout'],
  );
  const loginIndex = events.findIndex((event) => event.event && loginEvents.has(String(event.event)));
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
    logoutEvent.from = String(config.logoutFrom || 'authenticated');
    logoutEvent.to = String(config.logoutTo || 'anonymous');
    logoutEvent.timestamp = formatTimestamp(new Date(baseTimestamp.getTime() + deltaSeconds * 1000)) || baseEvent.timestamp;
    logoutEvent.deltaSeconds = deltaSeconds;
    logoutEvent.probability = 0;
    markAnomaly(logoutEvent, 'protocolViolation', { reason: 'logoutLoginLoop' }, markField);

    const repeatLogin = deepClone(baseEvent);
    repeatLogin.event = Array.from(loginEvents)[0] || 'login';
    repeatLogin.from = String(config.repeatLoginFrom || 'anonymous');
    repeatLogin.to = baseEvent.to || 'authenticated';
    repeatLogin.timestamp = formatTimestamp(new Date(baseTimestamp.getTime() + deltaSeconds * 2000)) || baseEvent.timestamp;
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
    ? (config.preLoginEvents as unknown[]).map((item) => String(item))
    : ['edit', 'view'];
  const selected = preLoginEvents[Math.floor(randomFn() * preLoginEvents.length)] || 'edit';
  const insertOffsetSeconds = Number(config.insertOffsetSeconds);
  const insertDeltaSeconds = Number(config.insertDeltaSeconds);
  const offsetSeconds = Number.isFinite(insertOffsetSeconds) ? insertOffsetSeconds : -5;
  const deltaSeconds =
    Number.isFinite(insertDeltaSeconds) && (insertDeltaSeconds as number) >= MIN_ANOMALY_DELTA
      ? (insertDeltaSeconds as number)
      : MIN_ANOMALY_DELTA;
  const referenceTimestamp = parseTimestamp(referenceEvent.timestamp) || new Date();
  const insertedTimestamp = new Date(referenceTimestamp.getTime() + offsetSeconds * 1000);

  const inserted = deepClone(referenceEvent);
  inserted.event = selected;
  inserted.from = String(config.preLoginFrom || 'anonymous');
  inserted.to = (referenceEvent.from as string) || 'unauthorized';
  inserted.timestamp = formatTimestamp(insertedTimestamp) || referenceEvent.timestamp;
  inserted.deltaSeconds = deltaSeconds;
  inserted.probability = 0;
  markAnomaly(inserted, 'protocolViolation', { reason: 'preLoginOperation' }, markField);

  events.splice(loginIndex, 0, inserted);
  deltaMap.set(inserted, 0);
  return true;
};

const applyTimeDeviation = ({ events, options, randomFn, markField, session }: MutationContext): boolean => {
  if (!Array.isArray(events) || events.length < 2) {
    return false;
  }
  const config = (options.strategies.timeDeviation || {}) as Record<string, unknown>;
  const candidateIndices: number[] = [];
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
    ? (Number.isFinite(longGap) && longGap > 0 ? (longGap as number) : 300)
    : Math.max(MIN_ANOMALY_DELTA, Number.isFinite(shortGap) ? (shortGap as number) : 0.05);

  const newTimestamp = new Date(previousTimestamp.getTime() + desiredDelta * 1000);
  const currentTimestamp = parseTimestamp(target.timestamp) || newTimestamp;
  const deltaShift = newTimestamp.getTime() - currentTimestamp.getTime();

  const propagationSelection = selectPropagationMode(config, events, options, session ?? null, chosenIndex);
  const propagationMode = propagationSelection.mode;
  const propagateWeight = propagationSelection.weight;

  target.timestamp = formatTimestamp(newTimestamp) || target.timestamp;
  target.deltaSeconds = desiredDelta;
  if (!target.metadata || typeof target.metadata !== 'object') {
    target.metadata = {};
  }
  const metaRecord = target.metadata as Record<string, unknown>;
  const timeMeta = (metaRecord.time_anomaly as Record<string, unknown>) || {};
  timeMeta.propagation_mode = propagationMode;
  timeMeta.gap_type = useLongGap ? 'long' : 'short';
  timeMeta.desired_delta = desiredDelta;
  timeMeta.weights = {
    propagate: propagateWeight,
    local: Math.max(0, 1 - propagateWeight),
  };
  metaRecord.time_anomaly = timeMeta;
  markAnomaly(
    target,
    'timeDeviation',
    {
      mode: useLongGap ? 'long' : 'short',
      desiredDelta,
      propagationMode,
      propagateWeight,
    },
    markField,
  );

  if (deltaShift !== 0 && propagationMode === 'propagate') {
    shiftTimestamps(events, chosenIndex + 1, deltaShift);
  }
  return true;
};

const applyAuthenticationBypass = ({ events, options, randomFn, markField }: MutationContext): boolean => {
  if (!Array.isArray(events) || events.length === 0) {
    return false;
  }
  const config = (options.strategies.authenticationBypass || {}) as Record<string, unknown>;
  const unauthorizedEvents = new Set(
    Array.isArray(config.unauthorizedEvents) && config.unauthorizedEvents.length > 0
      ? (config.unauthorizedEvents as unknown[]).map((item) => String(item).toLowerCase())
      : [],
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
  const invalidSessionPrefix = String(config.invalidSessionPrefix || 'invalid-session');
  const invalidUserPrefix = String(config.invalidUserPrefix || 'spoofed-user');

  target.session_id = `${invalidSessionPrefix}-${suffix}`;
  target.user_id = `${invalidUserPrefix}-${suffix}`;

  if (config.markAsUnauthenticated) {
    target.authenticated = false;
  }
  if (!target.metadata || typeof target.metadata !== 'object') {
    target.metadata = {};
  }
  const metadata = target.metadata as Record<string, unknown>;
  const existingAuth = (metadata.auth as Record<string, unknown>) || {};
  metadata.auth = {
    ...existingAuth,
    status: 'invalid',
    reason: 'unauthorizedOperation',
  };
  target.authTokenValid = false;
  target.sessionSpoofed = true;

  markAnomaly(target, 'authenticationBypass', { reason: 'unauthorizedOperation' }, markField);
  return true;
};

export const injectAnomaly = (
  sequence: readonly SimulationEvent[],
  userOptions: AnomalyInjectionOptions = {},
): SimulationEvent[] => {
  if (!Array.isArray(sequence)) {
    return [];
  }
  if (sequence.length === 0) {
    return [];
  }

  const mergedOptions: NormalizedOptions = {
    ...deepMerge(DEFAULT_OPTIONS, userOptions as Record<string, unknown>),
    anomalyRate: DEFAULT_OPTIONS.anomalyRate,
    anomalyCount: DEFAULT_OPTIONS.anomalyCount,
    interval: DEFAULT_OPTIONS.interval,
    minAnomalies: DEFAULT_OPTIONS.minAnomalies,
    maxAnomalies: DEFAULT_OPTIONS.maxAnomalies,
    seed: userOptions.seed ?? DEFAULT_OPTIONS.seed,
    markField: (userOptions.markField ?? DEFAULT_OPTIONS.markField) as string | null,
    strategies: deepMerge(DEFAULT_OPTIONS.strategies, userOptions.strategies as Record<string, unknown> | undefined),
    session: (userOptions.session ?? DEFAULT_OPTIONS.session) as SessionContext | null,
  };

  if (typeof userOptions.anomalyRate === 'number') {
    mergedOptions.anomalyRate = userOptions.anomalyRate;
  }
  if (userOptions.anomalyCount !== undefined) {
    mergedOptions.anomalyCount = userOptions.anomalyCount as number | null;
  }
  if (userOptions.interval !== undefined) {
    mergedOptions.interval = userOptions.interval as number | null;
  }
  if (typeof userOptions.minAnomalies === 'number') {
    mergedOptions.minAnomalies = userOptions.minAnomalies;
  }
  if (userOptions.maxAnomalies !== undefined) {
    mergedOptions.maxAnomalies = userOptions.maxAnomalies as number | null;
  }

  const randomFn = createPrng(mergedOptions.seed);
  const deltaMap = new WeakMap<SimulationEvent, number>();
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

  const context: MutationContext = {
    events: mutated,
    options: mergedOptions,
    randomFn,
    markField: mergedOptions.markField,
    deltaMap,
    session: mergedOptions.session ?? null,
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

const anomalyInjector = {
  injectAnomaly,
};

export default anomalyInjector;
