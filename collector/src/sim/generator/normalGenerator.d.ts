import type { SimulationEvent } from '../../services/simulationService';

export interface ScenarioDefinition extends Record<string, unknown> {}

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

export function generateNormalSequence(options?: GenerateNormalSequenceOptions): NormalEvent[];

declare const normalGenerator: {
  generateNormalSequence: typeof generateNormalSequence;
};

export { GenerateNormalSequenceOptions, NormalEvent, ScenarioDefinition, generateNormalSequence };
export default normalGenerator;
