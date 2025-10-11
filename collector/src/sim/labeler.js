'use strict';

const labelSequence = (sequence) => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  return sequence.map((event) => ({
    ...event,
    anomalyLabel: event.anomaly === true ? 1 : 0,
  }));
};

module.exports = {
  labelSequence,
};
