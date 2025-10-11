'use strict';

const injectAnomaly = (sequence, strategy = 'timestampOffset') => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  if (sequence.length === 0) {
    return [];
  }

  const mutated = sequence.map((event) => ({ ...event }));
  const targetIndex = Math.max(0, mutated.length - 1);
  const target = mutated[targetIndex];

  if (strategy === 'timestampOffset') {
    target.deltaOffsetSeconds = Number.isFinite(target.deltaOffsetSeconds)
      ? target.deltaOffsetSeconds + 5
      : 5;
  } else {
    target.protocolViolation = strategy;
  }

  target.anomaly = true;
  return mutated;
};

module.exports = {
  injectAnomaly,
};
