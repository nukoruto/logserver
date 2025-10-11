'use strict';

const { loadScenario, DEFAULT_SCENARIO_FILE } = require('../scenario');

const DEFAULT_MAX_STEPS = 128;
const DEFAULT_DELTA_RANGE = { min: 1, max: 3 };

const isFiniteNumber = (value) => Number.isFinite(value);

const normalizeSeed = (seed) => {
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

const resolveScenario = (scenarioOption) => {
  if (scenarioOption && typeof scenarioOption === 'object' && !Array.isArray(scenarioOption)) {
    return scenarioOption;
  }
  if (typeof scenarioOption === 'string' && scenarioOption.length > 0) {
    return loadScenario(scenarioOption);
  }
  return loadScenario(DEFAULT_SCENARIO_FILE);
};

const validateScenario = (scenario) => {
  if (!scenario || typeof scenario !== 'object') {
    throw new Error('Scenario definition is required');
  }
  if (!Array.isArray(scenario.states) || scenario.states.length === 0) {
    throw new Error('Scenario states must be a non-empty array');
  }
  if (!Array.isArray(scenario.transitions) || scenario.transitions.length === 0) {
    throw new Error('Scenario transitions must be a non-empty array');
  }
};

const normalizeDeltaRange = (candidate, fallback) => {
  if (candidate && typeof candidate === 'object') {
    const min = Number(candidate.min);
    const max = Number(candidate.max);
    if (isFiniteNumber(min) && isFiniteNumber(max) && max >= min && min >= 0) {
      return { min, max };
    }
  }
  if (isFiniteNumber(candidate) && candidate >= 0) {
    return { min: candidate, max: candidate };
  }
  return { ...fallback };
};

const sampleUniform = (range, randomFn) => {
  if (range.min === range.max) {
    return range.min;
  }
  const value = range.min + (range.max - range.min) * randomFn();
  return value;
};

const sampleDeltaSeconds = (transition, randomFn, defaultRange) => {
  const fallback = normalizeDeltaRange(defaultRange, DEFAULT_DELTA_RANGE);
  const range = normalizeDeltaRange(transition.deltaSeconds, fallback);
  const sampled = sampleUniform(range, randomFn);
  return Math.max(0, Number(sampled));
};

const normalizeProbabilities = (transitions) => {
  const hasExplicitProbability = transitions.some((item) => isFiniteNumber(item.probability) && item.probability > 0);
  if (hasExplicitProbability) {
    const total = transitions.reduce((sum, item) => {
      const value = isFiniteNumber(item.probability) && item.probability > 0 ? item.probability : 0;
      return sum + value;
    }, 0);
    const normalizedTotal = total > 0 ? total : 1;
    return transitions.map((item) => {
      const value = isFiniteNumber(item.probability) && item.probability > 0 ? item.probability : 0;
      return { ...item, normalizedProbability: value / normalizedTotal };
    });
  }
  const totalWeight = transitions.reduce((sum, item) => {
    const weight = isFiniteNumber(item.weight) && item.weight > 0 ? item.weight : 1;
    return sum + weight;
  }, 0);
  const denominator = totalWeight > 0 ? totalWeight : transitions.length;
  return transitions.map((item) => {
    const weight = isFiniteNumber(item.weight) && item.weight > 0 ? item.weight : 1;
    return { ...item, normalizedProbability: weight / denominator };
  });
};

const buildTransitionMap = (scenario) => {
  const adjacency = new Map();
  scenario.transitions.forEach((transition) => {
    if (!transition || !transition.from || !transition.to || !transition.event) {
      return;
    }
    if (!adjacency.has(transition.from)) {
      adjacency.set(transition.from, []);
    }
    adjacency.get(transition.from).push({ ...transition });
  });

  adjacency.forEach((list, key) => {
    if (!Array.isArray(list) || list.length === 0) {
      return;
    }
    adjacency.set(key, normalizeProbabilities(list));
  });
  return adjacency;
};

const selectTransition = (candidates, randomFn) => {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const roll = randomFn();
  let cumulative = 0;
  for (const candidate of candidates) {
    const probability = candidate.normalizedProbability || 0;
    cumulative += probability;
    if (roll <= cumulative + Number.EPSILON) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1];
};

const resolveInitialState = (scenario) => {
  if (scenario.initialState && typeof scenario.initialState === 'string') {
    return scenario.initialState;
  }
  return scenario.states[0];
};

const resolveTerminalStates = (scenario, adjacency) => {
  if (Array.isArray(scenario.terminalStates) && scenario.terminalStates.length > 0) {
    return new Set(scenario.terminalStates);
  }
  const terminals = new Set();
  scenario.states.forEach((state) => {
    if (!adjacency.has(state) || adjacency.get(state).length === 0) {
      terminals.add(state);
    }
  });
  return terminals;
};

const ensureDate = (value) => {
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

const generateNormalSequence = (options = {}) => {
  const scenario = resolveScenario(options.scenario);
  validateScenario(scenario);

  const randomFn = createPrng(options.seed);
  const adjacency = buildTransitionMap(scenario);
  const terminalStates = resolveTerminalStates(scenario, adjacency);
  const initialState = resolveInitialState(scenario);
  const maxSteps = Number.isInteger(options.maxSteps) && options.maxSteps > 0 ? options.maxSteps : DEFAULT_MAX_STEPS;
  const defaultDelta = normalizeDeltaRange(scenario.defaultDeltaSeconds, DEFAULT_DELTA_RANGE);

  const startTime = ensureDate(options.startTime);
  const sequence = [];
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

    const deltaSeconds = sampleDeltaSeconds(chosen, randomFn, defaultDelta);
    currentTime = new Date(currentTime.getTime() + deltaSeconds * 1000);

    const eventRecord = {
      from: chosen.from,
      to: chosen.to,
      event: chosen.event,
      timestamp: currentTime.toISOString(),
      deltaSeconds,
      probability: chosen.normalizedProbability,
      anomaly: false,
    };

    if (chosen.metadata && typeof chosen.metadata === 'object') {
      eventRecord.metadata = { ...chosen.metadata };
    }

    sequence.push(eventRecord);

    currentState = chosen.to;
    steps += 1;

    if (terminalStates.has(currentState)) {
      break;
    }
  }

  return sequence;
};

module.exports = {
  generateNormalSequence,
};
