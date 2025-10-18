import type { SimulationEvent } from '../../services/simulationService';

export type ScenarioDefinition = Record<string, unknown>;

export interface GenerateNormalSequenceOptions extends Record<string, unknown> {
  scenario?: ScenarioDefinition | string;
  seed?: string | number | null;
  maxSteps?: number;
  startTime?: Date | string;
  sessionId?: string | null;
  uid?: string | null;
  namespace?: string | null;
  rngFactory?: (category: string) => () => number;
  deltaEpsilon?: number | string | null;
}

export type NormalEvent = SimulationEvent & {
  from?: string;
  to?: string;
  probability?: number;
};

export function generateNormalSequence(options?: GenerateNormalSequenceOptions): NormalEvent[];
export const DEFAULT_DELTA_EPSILON: number;

declare const normalGenerator: {
  generateNormalSequence: typeof generateNormalSequence;
};

export { GenerateNormalSequenceOptions, NormalEvent, ScenarioDefinition, generateNormalSequence, DEFAULT_DELTA_EPSILON };
export default normalGenerator;
