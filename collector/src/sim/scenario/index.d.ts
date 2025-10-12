export interface ScenarioDefinition extends Record<string, unknown> {
  id?: string;
  states?: string[];
  transitions?: Record<string, unknown>[];
}

export const DEFAULT_SCENARIO_FILE: string;
export const EXTERNAL_DEFAULT_FILE: string;

export function loadScenario(filePath?: string | null): ScenarioDefinition;

declare const scenarioModule: {
  DEFAULT_SCENARIO_FILE: typeof DEFAULT_SCENARIO_FILE;
  EXTERNAL_DEFAULT_FILE: typeof EXTERNAL_DEFAULT_FILE;
  loadScenario: typeof loadScenario;
};

export { loadScenario };
export default scenarioModule;
