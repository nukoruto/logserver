import { DEFAULT_SCENARIO_FILE, loadScenario } from '../scenario';
import type { ScenarioDefinition } from '../scenario';
import type { SimulationEvent } from '../../services/simulationService';
import {
  createSessionCategoryPrng,
  type CategoryPrngFactory,
} from './prng';

export interface GenerateNormalSequenceOptions extends Record<string, unknown> {
  scenario?: ScenarioDefinition | string;
  seed?: string | number | null;
  maxSteps?: number;
  startTime?: Date | string;
  sessionId?: string | null;
  uid?: string | null;
  namespace?: string | null;
  rngFactory?: CategoryPrngFactory;
}

export type NormalEvent = SimulationEvent & {
  from?: string;
  to?: string;
  probability?: number;
};

const MAD_TO_STD = 1.4826;
const MIN_SIGMA_LOG = 1e-6;
const MIN_SIGMA_SQUARED = MIN_SIGMA_LOG * MIN_SIGMA_LOG;
export const DEFAULT_DELTA_EPSILON = 1e-3;

interface DeltaSpec {
  muLog: number;
  sigmaLog: number;
  epsilon: number;
}

interface ScenarioTransition extends Record<string, unknown> {
  from?: string;
  to?: string;
  event?: string;
  probability?: number;
  weight?: number;
  normalizedProbability?: number;
  deltaSeconds?: unknown;
  metadata?: Record<string, unknown>;
}

const DEFAULT_MAX_STEPS = 128;
const DEFAULT_DELTA_SPEC: DeltaSpec = {
  muLog: 0.5815754049028404,
  sigmaLog: 0.47238072707743883,
  epsilon: DEFAULT_DELTA_EPSILON,
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const resolveScenario = (scenarioOption: ScenarioDefinition | string | undefined): ScenarioDefinition => {
  if (scenarioOption && typeof scenarioOption === 'object' && !Array.isArray(scenarioOption)) {
    return scenarioOption;
  }
  if (typeof scenarioOption === 'string' && scenarioOption.length > 0) {
    return loadScenario(scenarioOption);
  }
  return loadScenario(DEFAULT_SCENARIO_FILE);
};

const validateScenario = (scenario: ScenarioDefinition): void => {
  const states = Array.isArray(scenario.states) ? scenario.states : [];
  if (states.length === 0) {
    throw new Error('Scenario states must be a non-empty array');
  }
  const transitions = Array.isArray(scenario.transitions) ? scenario.transitions : [];
  if (transitions.length === 0) {
    throw new Error('Scenario transitions must be a non-empty array');
  }
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const toPositiveFiniteNumber = (value: unknown): number | null => {
  const parsed = toFiniteNumber(value);
  if (parsed !== null && parsed > 0) {
    return parsed;
  }
  return null;
};

const cloneDeltaSpec = (spec: DeltaSpec | undefined | null): DeltaSpec => {
  if (!spec) {
    return { ...DEFAULT_DELTA_SPEC };
  }
  return {
    muLog: spec.muLog,
    sigmaLog: Math.max(spec.sigmaLog, MIN_SIGMA_LOG),
    epsilon: spec.epsilon > 0 ? spec.epsilon : DEFAULT_DELTA_EPSILON,
  };
};

const deriveLogParamsFromMoments = (
  meanSeconds: number | null,
  stdSeconds: number | null,
): { muLog: number; sigmaLog: number } | null => {
  if (meanSeconds === null || !Number.isFinite(meanSeconds) || meanSeconds <= 0) {
    return null;
  }
  if (stdSeconds === null || !Number.isFinite(stdSeconds) || stdSeconds < 0) {
    return null;
  }
  const normalizedStd = Math.max(stdSeconds, MIN_SIGMA_LOG);
  const variance = normalizedStd * normalizedStd;
  const ratio = variance / (meanSeconds * meanSeconds);
  const sigmaSquared = Math.log(1 + ratio);
  const sigma = Math.sqrt(Math.max(sigmaSquared, MIN_SIGMA_SQUARED));
  const mu = Math.log(meanSeconds) - sigmaSquared / 2;
  return { muLog: mu, sigmaLog: Math.max(sigma, MIN_SIGMA_LOG) };
};

const normalizeDeltaSpec = (candidate: unknown, fallbackSpec: DeltaSpec = DEFAULT_DELTA_SPEC): DeltaSpec => {
  const fallback = cloneDeltaSpec(fallbackSpec);

  if (candidate === undefined || candidate === null) {
    return fallback;
  }

  if (typeof candidate === 'number' || typeof candidate === 'string') {
    const numeric = toPositiveFiniteNumber(candidate);
    if (numeric !== null) {
      return {
        muLog: Math.log(numeric),
        sigmaLog: fallback.sigmaLog,
        epsilon: fallback.epsilon,
      };
    }
    return fallback;
  }

  if (typeof candidate !== 'object') {
    return fallback;
  }

  const record = candidate as Record<string, unknown>;
  const distribution = typeof record.distribution === 'string' ? record.distribution.toLowerCase() : 'lognormal';

  const epsilonCandidate =
    toPositiveFiniteNumber(record.epsilon ?? record.floor ?? record.minEpsilon ?? record.eps ?? record.minimum) ??
    fallback.epsilon;
  const epsilon = epsilonCandidate > 0 ? epsilonCandidate : fallback.epsilon;

  let muLog =
    toFiniteNumber(record.muLog ?? record.mu_log ?? record.medianLog ?? record.median_log ?? record.location) ?? null;
  if (muLog === null) {
    const medianSeconds = toPositiveFiniteNumber(record.medianSeconds ?? record.median ?? record.typical);
    if (medianSeconds !== null) {
      muLog = Math.log(medianSeconds);
    }
  }

  let sigmaLog =
    toPositiveFiniteNumber(record.sigmaLog ?? record.sigma_log ?? record.stdLog ?? record.std_log ?? record.scale) ?? null;
  if (sigmaLog === null) {
    const madLog = toPositiveFiniteNumber(record.madLog ?? record.mad_log ?? record.mad);
    if (madLog !== null) {
      sigmaLog = Math.max(madLog * MAD_TO_STD, MIN_SIGMA_LOG);
    }
  }

  let meanSeconds: number | null = null;
  let stdSeconds: number | null = null;

  if (distribution === 'normal') {
    meanSeconds = toPositiveFiniteNumber(record.mean ?? record.mu ?? record.expected ?? record.location);
    stdSeconds = toPositiveFiniteNumber(record.stdDev ?? record.std ?? record.sigma ?? record.scale);
  } else if (distribution === 'uniform') {
    const minCandidate = toPositiveFiniteNumber(record.min ?? record.lower ?? record.start);
    const maxCandidate = toPositiveFiniteNumber(record.max ?? record.upper ?? record.end);
    if (minCandidate !== null && maxCandidate !== null && maxCandidate >= minCandidate) {
      const spread = maxCandidate - minCandidate;
      meanSeconds = (minCandidate + maxCandidate) / 2;
      stdSeconds = Math.max(spread / Math.sqrt(12), MIN_SIGMA_LOG);
    }
  }

  if ((meanSeconds === null || stdSeconds === null) && distribution !== 'lognormal') {
    const altMean = toPositiveFiniteNumber(record.mean ?? record.mu);
    const altStd = toPositiveFiniteNumber(record.stdDev ?? record.std ?? record.sigma);
    if (meanSeconds === null && altMean !== null) {
      meanSeconds = altMean;
    }
    if (stdSeconds === null && altStd !== null) {
      stdSeconds = altStd;
    }
  }

  if ((muLog === null || sigmaLog === null) && meanSeconds !== null) {
    const derived = deriveLogParamsFromMoments(meanSeconds, stdSeconds ?? MIN_SIGMA_LOG);
    if (derived) {
      if (muLog === null) {
        muLog = derived.muLog;
      }
      if (sigmaLog === null || sigmaLog <= MIN_SIGMA_LOG) {
        sigmaLog = derived.sigmaLog;
      }
    }
  }

  if (muLog === null) {
    muLog = fallback.muLog;
  }
  if (sigmaLog === null || !Number.isFinite(sigmaLog) || sigmaLog <= MIN_SIGMA_LOG) {
    sigmaLog = fallback.sigmaLog;
  }

  return {
    muLog,
    sigmaLog: Math.max(sigmaLog, MIN_SIGMA_LOG),
    epsilon,
  };
};

const sampleStandardNormal = (randomFn: () => number): number => {
  let u1 = 0;
  let u2 = 0;
  while (u1 <= Number.EPSILON) {
    u1 = randomFn();
    u2 = randomFn();
  }
  const magnitude = Math.sqrt(-2.0 * Math.log(u1));
  return magnitude * Math.cos(2.0 * Math.PI * u2);
};

const sampleFromSpec = (spec: DeltaSpec, randomFn: () => number): number => {
  const epsilon = spec.epsilon > 0 ? spec.epsilon : DEFAULT_DELTA_EPSILON;
  const standard = sampleStandardNormal(randomFn);
  const logSample = spec.muLog + spec.sigmaLog * standard;
  const safeLog = Math.min(logSample, 700);
  const candidate = Math.exp(safeLog);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return epsilon;
  }
  return Math.max(epsilon, candidate);
};

const sampleDeltaSeconds = (
  transition: ScenarioTransition,
  randomFn: () => number,
  defaultSpec: DeltaSpec,
): number => {
  const fallbackSpec = normalizeDeltaSpec(defaultSpec, DEFAULT_DELTA_SPEC);
  const spec = normalizeDeltaSpec(transition.deltaSeconds, fallbackSpec);
  const sampled = sampleFromSpec(spec, randomFn);
  return Number.isFinite(sampled) && sampled > 0 ? sampled : spec.epsilon;
};

const normalizeProbabilities = (transitions: ScenarioTransition[]): ScenarioTransition[] => {
  const hasExplicitProbability = transitions.some(
    (item) => isFiniteNumber(item.probability) && (item.probability as number) > 0,
  );
  if (hasExplicitProbability) {
    const total = transitions.reduce((sum, item) => {
      const value = isFiniteNumber(item.probability) && (item.probability as number) > 0 ? (item.probability as number) : 0;
      return sum + value;
    }, 0);
    const normalizedTotal = total > 0 ? total : 1;
    return transitions.map((item) => {
      const value = isFiniteNumber(item.probability) && (item.probability as number) > 0 ? (item.probability as number) : 0;
      return { ...item, normalizedProbability: value / normalizedTotal };
    });
  }
  const totalWeight = transitions.reduce((sum, item) => {
    const weight = isFiniteNumber(item.weight) && (item.weight as number) > 0 ? (item.weight as number) : 1;
    return sum + weight;
  }, 0);
  const denominator = totalWeight > 0 ? totalWeight : transitions.length;
  return transitions.map((item) => {
    const weight = isFiniteNumber(item.weight) && (item.weight as number) > 0 ? (item.weight as number) : 1;
    return { ...item, normalizedProbability: weight / denominator };
  });
};

const buildTransitionMap = (scenario: ScenarioDefinition): Map<string, ScenarioTransition[]> => {
  const adjacency = new Map<string, ScenarioTransition[]>();
  const transitions = Array.isArray(scenario.transitions) ? scenario.transitions : [];
  transitions.forEach((transition) => {
    if (!transition || typeof transition !== 'object') {
      return;
    }
    const typed = transition as ScenarioTransition;
    if (!typed.from || !typed.to || !typed.event) {
      return;
    }
    const from = String(typed.from);
    if (!adjacency.has(from)) {
      adjacency.set(from, []);
    }
    adjacency.get(from)?.push({ ...typed });
  });

  adjacency.forEach((list, key) => {
    if (!Array.isArray(list) || list.length === 0) {
      return;
    }
    adjacency.set(key, normalizeProbabilities(list));
  });
  return adjacency;
};

const selectTransition = (
  candidates: ScenarioTransition[] | undefined,
  randomFn: () => number,
): ScenarioTransition | null => {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const roll = randomFn();
  let cumulative = 0;
  for (const candidate of candidates) {
    const probability = Number(candidate.normalizedProbability || 0);
    cumulative += probability;
    if (roll <= cumulative + Number.EPSILON) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1];
};

const resolveInitialState = (scenario: ScenarioDefinition): string => {
  if (typeof scenario.initialState === 'string') {
    return scenario.initialState;
  }
  const states = Array.isArray(scenario.states) ? scenario.states : [];
  return states[0];
};

const resolveTerminalStates = (
  scenario: ScenarioDefinition,
  adjacency: Map<string, ScenarioTransition[]>,
): Set<string> => {
  if (Array.isArray(scenario.terminalStates) && scenario.terminalStates.length > 0) {
    return new Set(scenario.terminalStates);
  }
  const terminals = new Set<string>();
  const states = Array.isArray(scenario.states) ? scenario.states : [];
  states.forEach((state) => {
    if (!adjacency.has(state) || (adjacency.get(state)?.length ?? 0) === 0) {
      terminals.add(state);
    }
  });
  return terminals;
};

const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/;

const parseOffsetFromString = (value: string): number | null => {
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

const deriveOffsetMinutes = (value: Date | string | undefined): number => {
  if (typeof value === 'string' && value.length > 0) {
    const parsed = parseOffsetFromString(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  if (value instanceof Date) {
    const offset = -value.getTimezoneOffset();
    if (Number.isFinite(offset)) {
      return offset;
    }
  }
  return 0;
};

const ensureDate = (value: Date | string | undefined): Date => {
  if (!value) {
    return new Date();
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid startTime provided to generateNormalSequence');
  }
  return parsed;
};

const padNumber = (value: number, length = 2): string => value.toString().padStart(length, '0');

const formatTimestampWithOffset = (utcMillis: number, offsetMinutes: number): string => {
  const localMillis = utcMillis + offsetMinutes * 60_000;
  const date = new Date(localMillis);
  const year = date.getUTCFullYear();
  const month = padNumber(date.getUTCMonth() + 1);
  const day = padNumber(date.getUTCDate());
  const hours = padNumber(date.getUTCHours());
  const minutes = padNumber(date.getUTCMinutes());
  const seconds = padNumber(date.getUTCSeconds());
  const milliseconds = padNumber(date.getUTCMilliseconds(), 3);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offsetHours = padNumber(Math.floor(absoluteMinutes / 60));
  const offsetMins = padNumber(absoluteMinutes % 60);
  const suffix = offsetMinutes === 0 ? 'Z' : `${sign}${offsetHours}:${offsetMins}`;
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${suffix}`;
};

export const generateNormalSequence = (
  options: GenerateNormalSequenceOptions = {},
): NormalEvent[] => {
  const scenario = resolveScenario(options.scenario as ScenarioDefinition | string | undefined);
  validateScenario(scenario);

  const rngFactory: CategoryPrngFactory =
    options.rngFactory
    || createSessionCategoryPrng({
      seed: options.seed ?? null,
      sessionId: (options.sessionId as string | null | undefined) ?? null,
      uid: (options.uid as string | null | undefined) ?? null,
      namespace: (options.namespace as string | null | undefined) ?? 'normal',
    });
  const adjacency = buildTransitionMap(scenario);
  const terminalStates = resolveTerminalStates(scenario, adjacency);
  const initialState = resolveInitialState(scenario);
  const maxSteps = Number.isInteger(options.maxSteps) && (options.maxSteps as number) > 0
    ? (options.maxSteps as number)
    : DEFAULT_MAX_STEPS;
  const defaultDeltaSpec = normalizeDeltaSpec(scenario.defaultDeltaSeconds as unknown, DEFAULT_DELTA_SPEC);

  const startInput = options.startTime as Date | string | undefined;
  const offsetMinutes = deriveOffsetMinutes(startInput);
  const startTime = ensureDate(startInput);
  const sequence: NormalEvent[] = [];
  let currentState = initialState;
  let currentUtcMillis = startTime.getTime();
  let steps = 0;

  while (steps < maxSteps) {
    const candidates = adjacency.get(currentState);
    if (!Array.isArray(candidates) || candidates.length === 0) {
      break;
    }

    const transitionRng = rngFactory(`transition|${currentState}|step-${steps}`);
    const chosen = selectTransition(candidates, transitionRng);
    if (!chosen) {
      break;
    }

    const deltaRng = rngFactory(`delta|${String(chosen.event ?? 'unknown')}|step-${steps}`);
    const deltaSeconds = sampleDeltaSeconds(chosen, deltaRng, defaultDeltaSpec);
    currentUtcMillis += deltaSeconds * 1000;
    const timestampUtc = new Date(currentUtcMillis).toISOString();
    const timestampLocal = formatTimestampWithOffset(currentUtcMillis, offsetMinutes);

    const eventRecord: NormalEvent = {
      from: String(chosen.from),
      to: String(chosen.to),
      event: String(chosen.event),
      timestamp: timestampLocal,
      timestamp_utc: timestampUtc,
      deltaSeconds,
      probability: Number(chosen.normalizedProbability),
      anomaly: false,
    };

    if (chosen.metadata && typeof chosen.metadata === 'object') {
      eventRecord.metadata = { ...(chosen.metadata as Record<string, unknown>) };
    }

    const offsetSeconds = offsetMinutes * 60;
    if (!eventRecord.metadata || typeof eventRecord.metadata !== 'object') {
      eventRecord.metadata = {};
    }
    const metadataRecord = eventRecord.metadata as Record<string, unknown>;
    if (!('timezone_offset_seconds' in metadataRecord)) {
      metadataRecord.timezone_offset_seconds = offsetSeconds;
    }

    sequence.push(eventRecord);

    currentState = String(chosen.to);
    steps += 1;

    if (terminalStates.has(currentState)) {
      break;
    }
  }

  return sequence;
};

const normalGenerator = {
  generateNormalSequence,
};

export default normalGenerator;
