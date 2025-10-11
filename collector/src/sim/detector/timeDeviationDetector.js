'use strict';

const detectTimeDeviation = (sequence, thresholdSeconds = 3) => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  return sequence.map((event) => {
    const deviation = Number(event.deltaOffsetSeconds) || 0;
    return {
      ...event,
      timeDeviationFlag: Math.abs(deviation) >= thresholdSeconds,
    };
  });
};

module.exports = {
  detectTimeDeviation,
};
