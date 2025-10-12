import { DEFAULT_SCENARIO_FILE, loadScenario } from '../scenario';
import type { ScenarioDefinition } from '../scenario';
import type { SimulationEvent } from '../../services/simulationService';

export interface GenerateNormalSequenceOptions extends Record<string, unknown> {
  scenario?: ScenarioDefinition | string;
  seed?: string | number | null;
  maxSteps?: number;
  startTime?: Date | string;
}

export type NormalEvent = SimulationEvent & {
  from?: string;
  to?: string;
  probability?: number;
};

interface DeltaRange {
  min: number;
  max: number;
}

interface DeltaSpec {
  distribution: 'uniform' | 'normal';
  min: number;
  max: number;
  mean?: number;
  stdDev?: number;
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
const DEFAULT_DELTA_RANGE: DeltaRange = { min: 1, max: 3 };
const DEFAULT_DELTA_SPEC: DeltaSpec = {
  distribution: 'uniform',
  min: DEFAULT_DELTA_RANGE.min,
  max: DEFAULT_DELTA_RANGE.max,
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

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

const clampValue = (value: number, minimum: number, maximum: number): number => {
  let result = value;
  if (Number.isFinite(minimum)) {
    result = Math.max(minimum, result);
  }
  if (Number.isFinite(maximum)) {
    result = Math.min(maximum, result);
  }
  return result;
};

const normalizeRange = (candidate: unknown, fallback: DeltaRange): DeltaRange => {
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    const minCandidate = Number(record.min ?? record.lower ?? record.start);
    const maxCandidate = Number(record.max ?? record.upper ?? record.end);
    const min = isFiniteNumber(minCandidate) && minCandidate >= 0 ? minCandidate : fallback.min;
    const maxSource = isFiniteNumber(maxCandidate) && maxCandidate >= min ? maxCandidate : fallback.max;
    const max = Number.isFinite(maxSource) && maxSource >= min ? maxSource : min;
    return { min, max };
  }
  if (isFiniteNumber(candidate) && candidate >= 0) {
    return { min: candidate, max: candidate };
  }
  return { min: fallback.min, max: fallback.max };
};

const cloneDeltaSpec = (spec: DeltaSpec | undefined | null): DeltaSpec => {
  if (!spec) {
    return { ...DEFAULT_DELTA_SPEC };
  }
  if (spec.distribution === 'normal') {
    return {
      distribution: 'normal',
      mean: spec.mean,
      stdDev: spec.stdDev,
      min: spec.min,
      max: spec.max,
    };
  }
  return {
    distribution: 'uniform',
    min: spec.min,
    max: spec.max,
  };
};

const normalizeDeltaSpec = (candidate: unknown, fallbackSpec: DeltaSpec = DEFAULT_DELTA_SPEC): DeltaSpec => {
  const fallback = cloneDeltaSpec(fallbackSpec);
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    const distribution = typeof record.distribution === 'string' ? record.distribution.toLowerCase() : fallback.distribution;
    if (distribution === 'normal') {
      const mean = Number(record.mean ?? record.mu);
      const stdDevCandidate = Number(record.stdDev ?? record.std ?? record.sigma);
      if (isFiniteNumber(mean) && isFiniteNumber(stdDevCandidate) && stdDevCandidate > 0) {
        const stdDev = stdDevCandidate;
        const rangeHint: DeltaRange = {
          min: Number(record.min),
          max: Number(record.max),
        };
        const suggestedRange = normalizeRange(rangeHint, {
          min: Math.max(0, mean - 3 * stdDev),
          max: Math.max(Math.max(0, mean + 3 * stdDev), mean),
        });
        return {
          distribution: 'normal',
          mean,
          stdDev,
          min: suggestedRange.min,
          max: suggestedRange.max,
        };
      }
      return fallback;
    }
    if (distribution === 'uniform') {
      const range = normalizeRange(record, fallback.distribution === 'uniform' ? fallback : DEFAULT_DELTA_RANGE);
      return {
        distribution: 'uniform',
        min: range.min,
        max: range.max,
      };
    }
  }

  if (candidate && typeof candidate === 'object' && ('min' in candidate || 'max' in candidate)) {
    const range = normalizeRange(candidate, fallback.distribution === 'uniform' ? fallback : DEFAULT_DELTA_RANGE);
    return {
      distribution: 'uniform',
      min: range.min,
      max: range.max,
    };
  }

  if (isFiniteNumber(candidate) && candidate >= 0) {
    return {
      distribution: 'uniform',
      min: candidate,
      max: candidate,
    };
  }

  return fallback;
};

const sampleUniform = (range: DeltaRange, randomFn: () => number): number => {
  if (range.min === range.max) {
    return range.min;
  }
  return range.min + (range.max - range.min) * randomFn();
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

const sampleNormal = (mean: number, stdDev: number, randomFn: () => number): number => {
  const standard = sampleStandardNormal(randomFn);
  return mean + stdDev * standard;
};

const sampleFromSpec = (spec: DeltaSpec, randomFn: () => number): number => {
  if (spec.distribution === 'normal' && isFiniteNumber(spec.mean) && isFiniteNumber(spec.stdDev)) {
    const sampled = sampleNormal(spec.mean, spec.stdDev, randomFn);
    return clampValue(sampled, spec.min, spec.max);
  }
  const range: DeltaRange = { min: spec.min, max: spec.max };
  return sampleUniform(range, randomFn);
};

const sampleDeltaSeconds = (
  transition: ScenarioTransition,
  randomFn: () => number,
  defaultSpec: DeltaSpec,
): number => {
  const fallbackSpec = normalizeDeltaSpec(defaultSpec, DEFAULT_DELTA_SPEC);
  const spec = normalizeDeltaSpec(transition.deltaSeconds, fallbackSpec);
  const sampled = sampleFromSpec(spec, randomFn);
  return Math.max(0, Number(sampled));
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

const selectTransition = (candidates: ScenarioTransition[] | undefined, randomFn: () => number): ScenarioTransition | null => {
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

export const generateNormalSequence = (
  options: GenerateNormalSequenceOptions = {},
): NormalEvent[] => {
  const scenario = resolveScenario(options.scenario as ScenarioDefinition | string | undefined);
  validateScenario(scenario);

  const randomFn = createPrng(options.seed);
  const adjacency = buildTransitionMap(scenario);
  const terminalStates = resolveTerminalStates(scenario, adjacency);
  const initialState = resolveInitialState(scenario);
  const maxSteps = Number.isInteger(options.maxSteps) && (options.maxSteps as number) > 0
    ? (options.maxSteps as number)
    : DEFAULT_MAX_STEPS;
  const defaultDeltaSpec = normalizeDeltaSpec(scenario.defaultDeltaSeconds as unknown, DEFAULT_DELTA_SPEC);

  const startTime = ensureDate(options.startTime as Date | string | undefined);
  const sequence: NormalEvent[] = [];
  let currentState = initialState;
  let currentTime = new Date(startTime.getTime());
  let steps = 0;

  while (steps < maxSteps) {
    const candidates = adjacency.get(currentState);
    if (!Array.isArray(candidates) || candidates.length === 0) {
      break;
    }

    const chosen = selectTransition(candidates, randomFn);
    if (!chosen) {
      break;
    }

    const deltaSeconds = sampleDeltaSeconds(chosen, randomFn, defaultDeltaSpec);
    currentTime = new Date(currentTime.getTime() + deltaSeconds * 1000);

    const eventRecord: NormalEvent = {
      from: String(chosen.from),
      to: String(chosen.to),
      event: String(chosen.event),
      timestamp: currentTime.toISOString(),
      deltaSeconds,
      probability: Number(chosen.normalizedProbability),
      anomaly: false,
    };

    if (chosen.metadata && typeof chosen.metadata === 'object') {
      eventRecord.metadata = { ...(chosen.metadata as Record<string, unknown>) };
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
