'use strict';

const DEFAULT_OPTIONS = {
  method: 'quantile',
  quantile: 0.99,
  minSamples: 5,
  fallbackThresholdSeconds: null,
};

const isFiniteNumber = (value) => Number.isFinite(value);

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

const resolveDeltaSeconds = (current, previous) => {
  if (!current) {
    return null;
  }
  const declared = Number(current.deltaSeconds);
  if (isFiniteNumber(declared) && declared >= 0) {
    return declared;
  }
  if (!previous) {
    return null;
  }
  const currentTimestamp = parseTimestamp(current.timestamp);
  const previousTimestamp = parseTimestamp(previous.timestamp);
  if (currentTimestamp && previousTimestamp) {
    return Math.max(0, (currentTimestamp.getTime() - previousTimestamp.getTime()) / 1000);
  }
  return null;
};

const extractDeltaSeries = (sequence) => {
  if (!Array.isArray(sequence)) {
    return [];
  }
  const deltas = [];
  for (let index = 1; index < sequence.length; index += 1) {
    const delta = resolveDeltaSeconds(sequence[index], sequence[index - 1]);
    if (isFiniteNumber(delta)) {
      deltas.push(delta);
    }
  }
  return deltas;
};

const computeQuantile = (values, quantile) => {
  if (!Array.isArray(values) || values.length === 0) {
    return NaN;
  }
  const clampedQuantile = Math.min(Math.max(quantile, 0), 1);
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const position = (sorted.length - 1) * clampedQuantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
};

const resolveThreshold = (values, options) => {
  if (!Array.isArray(values) || values.length === 0) {
    return NaN;
  }
  const method = typeof options.method === 'string' ? options.method.toLowerCase() : DEFAULT_OPTIONS.method;
  if (method === 'fixed') {
    const fixed = Number(options.thresholdSeconds);
    return isFiniteNumber(fixed) ? fixed : NaN;
  }
  if (method === 'spot') {
    // TODO: Implement SPOT (Peaks Over Threshold) method.
    // Fallback to quantile-based threshold for initial implementation.
  }
  const quantileValue = Number(options.quantile);
  const targetQuantile = isFiniteNumber(quantileValue) ? quantileValue : DEFAULT_OPTIONS.quantile;
  return computeQuantile(values, targetQuantile);
};

const detectTimeDeviation = (sequence, options = {}) => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  const mergedOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const baselineSource = Array.isArray(mergedOptions.baselineSequence) ? mergedOptions.baselineSequence : sequence;
  const baselineDeltas = extractDeltaSeries(baselineSource).filter((value) => isFiniteNumber(value));
  const minSamples = Number.isInteger(mergedOptions.minSamples) && mergedOptions.minSamples > 0
    ? mergedOptions.minSamples
    : DEFAULT_OPTIONS.minSamples;

  let threshold = NaN;
  if (baselineDeltas.length >= minSamples) {
    threshold = resolveThreshold(baselineDeltas, mergedOptions);
  } else {
    const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
    if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
      const fallback = Number(fallbackRaw);
      if (isFiniteNumber(fallback) && fallback >= 0) {
        threshold = fallback;
      }
    }
  }

  if (!isFiniteNumber(threshold) && baselineDeltas.length > 0) {
    threshold = resolveThreshold(baselineDeltas, { ...mergedOptions, minSamples: 1 });
  }

  if (!isFiniteNumber(threshold)) {
    const fallbackRaw = mergedOptions.fallbackThresholdSeconds;
    if (fallbackRaw !== undefined && fallbackRaw !== null && fallbackRaw !== '') {
      const fallback = Number(fallbackRaw);
      if (isFiniteNumber(fallback) && fallback >= 0) {
        threshold = fallback;
      }
    }
  }

  if (!isFiniteNumber(threshold)) {
    threshold = 0;
  }

  const decorated = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index];
    const previous = index > 0 ? sequence[index - 1] : null;
    const observedDelta = index === 0 ? 0 : resolveDeltaSeconds(current, previous);
    const safeDelta = isFiniteNumber(observedDelta) ? observedDelta : 0;
    const score = Math.max(0, safeDelta - threshold);
    decorated.push({
      ...current,
      timeDeviationObservedDeltaSeconds: safeDelta,
      timeDeviationThresholdSeconds: threshold,
      timeDeviationScore: score,
      timeDeviationFlag: safeDelta > threshold,
    });
  }

  return decorated;
};

module.exports = {
  detectTimeDeviation,
  extractDeltaSeries,
  resolveThreshold,
};
