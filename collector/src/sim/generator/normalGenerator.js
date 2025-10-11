'use strict';

const { loadScenario, DEFAULT_SCENARIO_FILE } = require('../scenario');

const generateNormalSequence = (options = {}) => {
  const scenario = options.scenario || loadScenario(DEFAULT_SCENARIO_FILE);
  return scenario.transitions.map((transition) => ({
    ...transition,
    anomaly: false,
  }));
};

module.exports = {
  generateNormalSequence,
};
