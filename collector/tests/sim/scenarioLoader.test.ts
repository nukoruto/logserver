const { loadScenario, DEFAULT_SCENARIO_FILE } = require('../../src/sim/scenario');

describe('scenario loader with external JSON', () => {
  it('prefers configs/scenario_default.json when present', () => {
    const scenario = loadScenario();
    expect(scenario).toBeDefined();
    expect(scenario.description).toContain('Default session FSM');
    expect(scenario.version).toBe('2024-11-01');
  });

  it('loads specific file path when provided', () => {
    const fallbackScenario = loadScenario(DEFAULT_SCENARIO_FILE);
    expect(fallbackScenario).toBeDefined();
    expect(fallbackScenario.version).toBeUndefined();
  });
});

export {};
