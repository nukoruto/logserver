'use strict';

const validateProtocol = (sequence, allowedTransitions = null) => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  const transitionSet = new Set();
  if (Array.isArray(allowedTransitions)) {
    allowedTransitions.forEach((item) => {
      if (item && item.from && item.to) {
        transitionSet.add(`${item.from}->${item.to}`);
      }
    });
  }

  return sequence.map((event) => {
    const key = `${event.from}->${event.to}`;
    const valid = transitionSet.size === 0 ? true : transitionSet.has(key);
    return {
      ...event,
      protocolViolationFlag: !valid,
    };
  });
};

module.exports = {
  validateProtocol,
};
